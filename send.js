/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Thunderbird Conversations
 *
 * The Initial Developer of the Original Code is
 * Jonathan Protzenko
 * Portions created by the Initial Developer are Copyright (C) 2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

/**
 * @fileoverview This file provides a Javascript abstraction for sending a
 * message.
 * @author Jonathan Protzenko
 */

var EXPORTED_SYMBOLS = ['sendMessage']

const Ci = Components.interfaces;
const Cc = Components.classes;
const Cu = Components.utils;
const Cr = Components.results;

Cu.import("resource://gre/modules/PluralForm.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm"); // for generateQI
Cu.import("resource:///modules/MailUtils.js"); // for getFolderForURI

const gHeaderParser = Cc["@mozilla.org/messenger/headerparser;1"]
                      .getService(Ci.nsIMsgHeaderParser);
const msgComposeService = Cc["@mozilla.org/messengercompose;1"]
                          .getService(Ci.nsIMsgComposeService);
const mCompType = Ci.nsIMsgCompType;

let ext = __LOCATION__.path.match(/(\w+)@\w+/)[1];
let extPath = Cc["@mozilla.org/preferences-service;1"]
              .getService(Ci.nsIPrefService)
              .getBranch(null)
              .getCharPref(ext+".path");

Cu.import("resource://"+extPath+"/stdlib/misc.js");
Cu.import("resource://"+extPath+"/stdlib/msgHdrUtils.js");
Cu.import("resource://"+extPath+"/stdlib/compose.js");
Cu.import("resource://"+extPath+"/log.js");

let Log = setupLogging(logRoot+".Send");

/**
 * Get the Archive folder URI depending on the given identity and the given Date
 *  object.
 * @param {nsIMsgIdentity} identity
 * @param {Date} msgDate
 * @return {String} The URI for the folder. Use MailUtils.getFolderForURI.
 */
function getArchiveFolderUriFor(identity, msgDate) {
  let msgYear = msgDate.getFullYear().toString();
  let monthFolderName = msgDate.toLocaleFormat("%Y-%m");
  let granularity = identity.archiveGranularity;
  let folderUri = identity.archiveFolder;
  if (granularity >= Ci.nsIMsgIdentity.perYearArchiveFolders)
    folderUri += "/" + msgYear;
  if (granularity >= Ci.nsIMsgIdentity.perMonthArchiveFolders)
    folderUri += "/" + monthFolderName;
  return folderUri;
}

function wrapBody(t) {
  let r =
    "<!DOCTYPE HTML PUBLIC \"-//W3C//DTD HTML 4.01 Transitional//EN\">\n"+
    "<html>\n"+
    "  <head>\n"+
    "    <meta http-equiv=\"content-type\" content=\"text/html;\n"+
    "      charset=ISO-8859-1\">\n"+
    "  </head>\n"+
    "  <body>"+
    "    "+t+"\n"+
    "  </body>\n"+
    "</html>\n"
  ;
  return r;
}

/**
 * This is our fake editor. We manipulate carefully the functions from
 *  nsMsgCompose.cpp so that it just figures out we have an editor, but doesn't
 *  try to interact with it.
 * We'll probably try to improve this in the near future.
 */
function FakeEditor (aIframe) {
  this.iframe = aIframe;
}

FakeEditor.prototype = {
  getEmbeddedObjects: function _FakeEditor_getEmbeddedObjects () {
    try {
      let objects = Cc["@mozilla.org/supports-array;1"]
                      .createInstance(Ci.nsISupportsArray);
      for each (let [, o] in Iterator(this.iframe.contentDocument.getElementsByTagName("img")))
        objects.AppendElement(o, false);
      return objects;
    } catch (e) {
      Log.error(e);
      dumpCallStack(e);
    }
  },

  outputToString: function _FakeEditor_outputToString (formatType, flags) {
    Log.debug("Returning mail body for", formatType);
    let html = this.iframe.contentDocument.body.innerHTML;
    switch (formatType) {
      case "text/plain":
        return htmlToPlainText(html)+"\n";

      case "text/html":
        return wrapBody(html);

      default:
        Log.error("Unexpected formatType", formatType, flags);
    }
  },

  QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports, Ci.nsIEditor, Ci.nsIEditorMailSupport]),
}
// This has to be a root because once the msgCompose has deferred the treatment
//  of the send process to nsMsgSend.cpp, the nsMsgSend holds a reference to
//  nsMsgCopySendListener (nsMsgCompose.cpp). nsMsgCopySendListener holds a
//  *weak* reference to its corresponding nsIMsgCompose object, that in turns
//  forwards the notifications to our own little progressListener.
// So if no one holds a firm reference to gMsgCompose, then it might end up
//  being collected before the send process terminates, and then, it's BAD.
// The bad case would be:
//  * user hits "send"
//  * quickly changes conversations
//  * writes a new email
//  * the previous send hasn't completed, but the user hits send anyway
//  * gMsgCompose is overridden
//  * a garbage collection kicks in, collects the previous StateListener
//  * first send completes
//  * the first listener fails to receive the notification.
// That's way too implausible, so I'll just assume this doesn't happen!
let gMsgCompose;

/**
 * This is our monstrous Javascript function for sending a message. It hides all
 *  the atrocities of nsMsgCompose.cpp and nsMsgSend.cpp for you, and it
 *  provides what I hope is a much more understandable interface.
 * You are expected to provide the whole set of listeners. The most interesting
 *  one is the stateListener, since it has the ComposeProcessDone notification.
 * This version only does plaintext composition but I hope to enhance it with
 *  both HTML and plaintext in the future.
 * @param composeParameters
 * @param composeParameters.identity The identity the user picked to send the
 *  message
 * @param composeParameters.to The recipients. This is a comma-separated list of
 *  valid email addresses that must be escaped already. You probably want to use
 *  nsIMsgHeaderParser.MakeFullAddress to deal with names that contain commas.
 * @param composeParameters.cc (optional) Same remark.
 * @param composeParameters.bcc (optional) Same remark.
 * @param composeParameters.subject The subject, no restrictions on that one.
 * @param composeParameters.returnReceipt (optional)
 * @param composeParameters.receiptType (optional)
 * @param composeParameters.requestDsn (optional)
 *
 * @param sendingParameters
 * @param sendingParameters.deliverType See Ci.nsIMsgCompDeliverMode
 * @param sendingParameters.compType See Ci.nsIMsgCompType. We use this to
 *  determine what kind of headers we should set (Reply-To, References...).
 *
 * @param aBody A visitor pattern, again. Calls x.editor(iframe) if this is a
 *  fully-fledged html editing session, or calls x.plainText(body) if this is
 *  just a simple plaintext mail.
 *
 * @param listeners
 * @param listeners.progressListener That one monitors the progress of long
 *  operations (like sending a message with attachments), it's notified with the
 *  current percentage of completion.
 * @param listeners.sendListener That one receives notifications about factual
 *  events (sending, copying to Sent, ...). It receives notifications with
 *  statuses.
 * @param listeners.stateListener This one is a high-level listener that
 *   receives notifications about the global composition process.
 *
 * @param options
 * @param options.popOut Don't send the message, just transfer it to a new
 *  composition window.
 * @param options.archive Shall we archive the message right away? This won't
 *  even copy it to the Sent folder. Warning: this one assumes that the "right"
 *  Archives folder already exists.
 */
function sendMessage(params,
    { deliverType, compType },
    aBody,
    { progressListener, sendListener, stateListener },
    options) {

  let popOut = options && options.popOut;
  let archive = options && options.archive;

  let { msgHdr, identity, to, subject } = params;

  // Here is the part where we do all the stuff related to filling proper
  //  headers, adding references, making sure all the composition fields are
  //  properly set before assembling the message.
  let fields = Cc["@mozilla.org/messengercompose/composefields;1"]
                  .createInstance(Ci.nsIMsgCompFields);
  fields.from = gHeaderParser.makeFullAddress(identity.fullName, identity.email);
  fields.to = to;
  if ("cc" in params)
    fields.cc = params.cc;
  if ("bcc" in params)
    fields.bcc = params.bcc;
  fields.subject = subject;
  fields.returnReceipt = ("returnReceipt" in params)
    ? params.returnReceipt
    : identity.requestReturnReceipt;
  fields.receiptHeaderType = ("receiptType" in params)
    ? params.receiptType
    : identity.receiptHeaderType;
  fields.DSN = ("requestDsn" in params)
    ? params.requestDsn
    : identity.requestDSN;
  
  let references = [];
  switch (compType) {
    case mCompType.New:
      break;

    case mCompType.Reply:
    case mCompType.ReplyAll:
    case mCompType.ReplyToSender:
    case mCompType.ReplyToGroup:
    case mCompType.ReplyToSenderAndGroup:
    case mCompType.ReplyWithTemplate:
    case mCompType.ReplyToList:
      references = [msgHdr.getStringReference(i)
        for each (i in range(0, msgHdr.numReferences))];
      references.push(msgHdr.messageId);
      break;

    case mCompType.ForwardAsAttachment:
    case mCompType.ForwardInline:
      references.push(msgHdr.messageId);
      break;
  }
  references = ["<"+x+">" for each ([, x] in Iterator(references))];
  fields.references = references.join(" ");

  // TODO:
  // - fields.addAttachment (when attachments taken into account)

  // If we are to archive the conversation after sending, this means we also
  //  have to archive the sent message as well. The simple way to do it is to
  //  change the FCC (Folder CC) from the Sent folder to the Archives folder.
  if (archive) {
    // We're just assuming that the folder exists, this might not be the case...
    // But I am so NOT reimplementing the whole logic from
    //  http://mxr.mozilla.org/comm-central/source/mail/base/content/mailWindowOverlay.js#1293
    let folderUri = getArchiveFolderUriFor(identity, new Date());
    if (MailUtils.getFolderForURI(folderUri, true)) {
      Log.debug("Message will be copied in", folderUri, "once sent");
      fields.fcc = folderUri;
    } else {
      Log.warn("The archive folder doesn't exist yet, so the last message you sent won't be archived... sorry!");
    }
  }

  // We init the composition service with the right parameters, and we make sure
  //  we're announcing that we're about to compose in plaintext, so that it
  //  doesn't assume anything about having an editor (composing HTML implies
  //  having an editor instance for the compose service).
  // The variable we're interested in is m_composeHTML in nsMsgCompose.cpp – its
  //  initial value is PR_FALSE. The idea is that the msgComposeFields serve
  //  different purposes:
  //  - they initially represent the initial parameters to setup the compose
  //  window and,
  //  - once the composition is done, they represent the compose session that
  //  just finished (one notable exception is that if the editor is composing
  //  HTML, fields.body is irrelevant and the SendMsg code will query the editor
  //  for its HTML and/or plaintext contents).
  // The value is to be updated depending on the account's settings to determine
  //  whether we want HTML composition or not. This is nsMsgCompose::Initialize.
  //  Well, guess what? We're not calling that function, and we make sure
  //  m_composeHTML stays PR_FALSE until the end!
  let params = Cc["@mozilla.org/messengercompose/composeparams;1"]
                  .createInstance(Ci.nsIMsgComposeParams);
  params.composeFields = fields;
  params.identity = identity;
  params.type = compType;
  params.sendListener = sendListener;

  // If we want to switch to the external editor, we assembled all the
  //  composition fields properly. Pass them to a compose window, and move on.
  if (popOut) {
    // We set all the fields ourselves, force New so that the compose code
    //  doesn't try to figure out the parameters by itself.
    fields.characterSet = "UTF-8";
    fields.forcePlainText = false;
    // If we don't do that the editor compose window will think that the >s that
    //  are inserted by the user are voluntary, that is, they should be escaped
    //  so that they are not parsed as quotes. We don't want that!
    // The best solution is to fire the HTML editor and replace the cited lines
    //  by the appropriate blockquotes.
    // XXX please note that we are not trying to preserve spacing, or stuff like
    //  that -- they'll die in the translation. So ASCII art quoted in the quick
    //  reply won't be preserved. We also won't preserve the format=flowed
    //  thing: if we were to do the right thing (tm) we would unparse the quoted
    //  lines and push them as single lines in the HTML, with no <br>s in the
    //  middle, but well... I guess this is okay enough.
    aBody.match({
      plainText: function (body) {
        fields.body = plainTextToHtml(body);
      },
      editor: function (iframe) {
        let html = iframe.contentDocument.body.innerHTML;
        fields.body = html;
      },
    });

    params.format = Ci.nsIMsgCompFormat.HTML;
    // XXX maybe we should just use New everywhere since we're setting the
    //  parameters ourselves anyway...
    params.type = mCompType.New;
    msgComposeService.OpenComposeWindowWithParams(null, params);
    return true;
  } else {
    aBody.match({
      plainText: function(body) {
        // We're in 2011 now, let's assume everyone knows how to read UTF-8
        fields.bodyIsAsciiOnly = false;
        fields.characterSet = "UTF-8";
        fields.useMultipartAlternative = false;
        // So we should have something more elaborate than a simple textarea. The
        //  reason is, we should be able to differentiate between user-inserted >'s
        //  and quote-inserted >'s. (The standard Thunderbird plaintext editor does
        //  it with a blue color). The user-inserted >'s want a space prepended so
        //  that the MUA doesn't interpret them as quotation. Real quotations don't.
        // This is kinda out of scope so we're leaving the issue non-fixed but this
        //  is clearly a FIXME.
        params.format = Ci.nsIMsgCompFormat.PlainText;
        fields.forcePlainText = true;
        fields.body = simpleWrap(body, 72)+"\n";

        // This part initializes a nsIMsgCompose instance. This is useless, because
        //  that component is supposed to talk to the "real" compose window, set the
        //  encoding, set the composition mode... we're only doing that because we
        //  can't send the message ourselves because of too many [noscript]s.
        gMsgCompose = msgComposeService.initCompose(params);
      },

      editor: function (iframe) {
        fields.bodyIsAsciiOnly = false;
        fields.characterSet = "UTF-8";
        fields.useMultipartAlternative = true;
        gMsgCompose = msgComposeService.initCompose(
          params,
          iframe.contentWindow,
          iframe.contentWindow.docshell
        );
        // Here we trust the parameters that have been set by the call to
        // msgComposeService.InitCompose above, and we just assume the
        // fakeEditor will be able to output HTML and plainText as needed...
        let fakeEditor = new FakeEditor(iframe);
        gMsgCompose.initEditor(fakeEditor, iframe.contentWindow);
      },
    });

    // We create a progress listener...
    var progress = Cc["@mozilla.org/messenger/progress;1"]
                     .createInstance(Ci.nsIMsgProgress);
    if (progress && progressListener)
      progress.registerListener(progressListener);
    if (stateListener)
      gMsgCompose.RegisterStateListener(stateListener);

    try {
      gMsgCompose.SendMsg(deliverType, identity, "", null, progress);
    } catch (e) {
      Log.error(e);
      dumpCallStack(e);
    }
    return true;
  }
}
