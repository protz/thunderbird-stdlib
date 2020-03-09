/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @fileoverview This file provides a Javascript abstraction for sending a
 * message.
 * @author Jonathan Protzenko
 */

var EXPORTED_SYMBOLS = ["sendMessage"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

const logJSURL = new URL("../log.js", this.__URI__);

XPCOMUtils.defineLazyModuleGetters(this, {
  logRoot: logJSURL,
  MailServices: "resource:///modules/MailServices.jsm",
  MailUtils: "resource:///modules/MailUtils.jsm",
  setupLogging: logJSURL,
});

const mCompType = Ci.nsIMsgCompType;
const isWindows = "@mozilla.org/windows-registry-key;1" in Cc;

function importRelative(that, path) {
  return ChromeUtils.import(new URL(path, that.__URI__));
}

const { range } = importRelative(this, "misc.js");
const { msgUriToMsgHdr } = importRelative(this, "msgHdrUtils.js");
const {
  determineComposeHtml,
  getEditorForIframe,
  plainTextToHtml,
  htmlToPlainText,
  simpleWrap,
} = importRelative(this, "compose.js");

XPCOMUtils.defineLazyGetter(this, "Log", () => {
  return setupLogging(`${logRoot}.Send`);
});

/**
 * Get the Archive folder URI depending on the given identity and the given Date
 *  object.
 * @param {nsIMsgIdentity} identity
 * @param {Date} msgDate
 * @return {String} The URI for the folder. Use MailUtils.getFolderForURI.
 */
function getArchiveFolderUriFor(identity, msgDate) {
  let msgYear = msgDate.getFullYear().toString();
  let monthFolderName =
    msgYear + "-" + (msgDate.getMonth() + 1).toString().padStart(2, "0");
  let granularity = identity.archiveGranularity;
  let folderUri = identity.archiveFolder;
  let archiveFolder = MailUtils.getFolderForURI(folderUri, false);
  let forceSingle = !archiveFolder.canCreateSubfolders;
  if (
    !forceSingle &&
    archiveFolder.server instanceof Ci.nsIImapIncomingServer
  ) {
    forceSingle = archiveFolder.server.isGMailServer;
  }
  if (forceSingle) {
    return folderUri;
  }
  if (granularity >= Ci.nsIMsgIdentity.perYearArchiveFolders) {
    folderUri += "/" + msgYear;
  }
  if (granularity >= Ci.nsIMsgIdentity.perMonthArchiveFolders) {
    folderUri += "/" + monthFolderName;
  }
  return folderUri;
}

/**
 * This is our fake editor. We manipulate carefully the functions from
 *  nsMsgCompose.cpp so that it just figures out we have an editor, but doesn't
 *  try to interact with it.
 * We'll probably try to improve this in the near future.
 */
function FakeEditor(aIframe) {
  this.iframe = aIframe;
  this.editor = getEditorForIframe(aIframe);
  this.editor.QueryInterface(Ci.nsIEditorMailSupport);
}

FakeEditor.prototype = {
  getEmbeddedObjects: function _FakeEditor_getEmbeddedObjects() {
    return this.editor.getEmbeddedObjects();
  },

  outputToString: function _FakeEditor_outputToString(formatType, flags) {
    return this.editor.outputToString(formatType, flags);
  },

  // bodyConvertible calls GetRootElement on m_editor which is supposed to be an
  // nsIEditor, so implement this property...
  get rootElement() {
    return this.iframe.contentDocument.body;
  },

  QueryInterface: ChromeUtils.generateQI([
    Ci.nsIEditor,
    Ci.nsIEditorMailSupport,
  ]),
};
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

function initCompose(aMsgComposeService, aParams, aWindow, aDocShell) {
  if ("InitCompose" in aMsgComposeService) {
    return aMsgComposeService.InitCompose(aWindow, aParams);
  }
  return aMsgComposeService.initCompose(aParams, aWindow, aDocShell);
}

/**
 * This is our monstrous Javascript function for sending a message. It hides all
 *  the atrocities of nsMsgCompose.cpp and nsMsgSend.cpp for you, and it
 *  provides what I hope is a much more understandable interface.
 * You are expected to provide the whole set of listeners. The most interesting
 *  one is the stateListener, since it has the ComposeProcessDone notification.
 * This version only does plaintext composition but I hope to enhance it with
 *  both HTML and plaintext in the future.
 * @param composeParameters
 * @param composeParameters.urls {Array} A list of message URLs that are to be
 *  used for references.
 * @param composeParameters.identity The identity the user picked to send the
 *  message
 * @param composeParameters.to The recipients. This is a comma-separated list of
 *  valid email addresses that must be escaped already. You probably want to use
 *  nsIMsgHeaderParser.MakeFullAddress to deal with names that contain commas.
 * @param composeParameters.cc (optional) Same remark.
 * @param composeParameters.bcc (optional) Same remark.
 * @param composeParameters.subject The subject, no restrictions on that one.
 * @param composeParameters.attachments A list of nsIMsgAttachment objects
 *  (optional)
 * @param composeParameters.returnReceipt (optional)
 * @param composeParameters.receiptType (optional)
 * @param composeParameters.requestDsn (optional)
 * @param composeParameters.securityInfo (optional)
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
// eslint-disable-next-line complexity
function sendMessage(
  aParams,
  { deliverType, compType },
  aBody,
  { progressListener, sendListener, stateListener },
  options
) {
  let popOut = options && options.popOut;
  let archive = options && options.archive;

  let { urls, identity, to, subject } = aParams;
  let attachments = aParams.attachments || [];

  // Here is the part where we do all the stuff related to filling proper
  //  headers, adding references, making sure all the composition fields are
  //  properly set before assembling the message.
  let fields = Cc[
    "@mozilla.org/messengercompose/composefields;1"
  ].createInstance(Ci.nsIMsgCompFields);
  fields.from = MailServices.headerParser.makeMimeAddress(
    identity.fullName,
    identity.email
  );
  fields.to = to;
  if ("cc" in aParams) {
    fields.cc = aParams.cc;
  }
  if ("bcc" in aParams) {
    fields.bcc = aParams.bcc;
  }
  fields.subject = subject;
  fields.returnReceipt =
    "returnReceipt" in aParams
      ? aParams.returnReceipt
      : identity.requestReturnReceipt;
  fields.receiptHeaderType =
    "receiptType" in aParams ? aParams.receiptType : identity.receiptHeaderType;
  fields.DSN =
    "requestDsn" in aParams ? aParams.requestDsn : identity.requestDSN;
  if ("securityInfo" in aParams) {
    fields.securityInfo = aParams.securityInfo;
  }

  let references = [];
  switch (compType) {
    case mCompType.New:
      break;

    case mCompType.Draft: {
      // Copy the references from the original draft into the message we're
      // about to send...
      Log.assert(
        urls.length == 1,
        "Can't edit more than one message at a time"
      );
      let msgHdr = msgUriToMsgHdr(urls[0]);
      references = [...range(0, msgHdr.numReferences)].map(i =>
        msgHdr.getStringReference(i)
      );
      break;
    }

    case mCompType.Reply:
    case mCompType.ReplyAll:
    case mCompType.ReplyToSender:
    case mCompType.ReplyToGroup:
    case mCompType.ReplyToSenderAndGroup:
    case mCompType.ReplyWithTemplate:
    case mCompType.ReplyToList: {
      Log.assert(
        urls.length == 1,
        "Can't reply to more than one message at a time"
      );
      let msgHdr = msgUriToMsgHdr(urls[0]);
      references = [...range(0, msgHdr.numReferences)].map(i =>
        msgHdr.getStringReference(i)
      );
      references.push(msgHdr.messageId);
      break;
    }

    case mCompType.ForwardAsAttachment: {
      for (let url of urls) {
        let msgHdr = msgUriToMsgHdr(url);
        references.push(msgHdr.messageId);
      }
      break;
    }

    case mCompType.ForwardInline: {
      Log.assert(
        urls.length == 1,
        "Can't forward inline more than one message at a time"
      );
      let msgHdr = msgUriToMsgHdr(urls[0]);
      references.push(msgHdr.messageId);
      break;
    }
  }
  references = references.map(x => "<" + x + ">");
  fields.references = references.join(" ");
  for (let x of attachments) {
    fields.addAttachment(x);
  }

  let fccFolder = identity.fccFolder;
  let fccSameFolder = identity.fccReplyFollowsParent;
  let doFcc = identity.doFcc;
  let isReply =
    compType == Ci.nsIMsgCompType.Reply ||
    compType == Ci.nsIMsgCompType.ReplyAll ||
    compType == Ci.nsIMsgCompType.ReplyToGroup ||
    compType == Ci.nsIMsgCompType.ReplyToSender ||
    compType == Ci.nsIMsgCompType.ReplyToSenderAndGroup ||
    compType == Ci.nsIMsgCompType.ReplyWithTemplate;
  let defaultFcc = fccFolder.indexOf("nocopy://") == 0 ? "" : fccFolder;
  // Replicating the whole logic from nsMsgSend.cpp:2840... with our own archive
  // feat.
  if (archive) {
    // If we are to archive the conversation after sending, this means we also
    //  have to archive the sent message as well. The simple way to do it is to
    //  change the FCC (Folder CC) from the Sent folder to the Archives folder.
    let folderUri = getArchiveFolderUriFor(identity, new Date());
    if (MailUtils.getFolderForURI(folderUri, true)) {
      // We're just assuming that the folder exists, this might not be the case...
      // But I am so NOT reimplementing the whole logic from
      //  http://mxr.mozilla.org/comm-central/source/mail/base/content/mailWindowOverlay.js#1293
      Log.debug("Message will be copied in", folderUri, "once sent");
      fields.fcc = folderUri;
    } else {
      Log.warn(
        "The archive folder doesn't exist yet, so the last message you sent won't be archived... sorry!"
      );
      fields.fcc = defaultFcc;
    }
  } else if (!doFcc) {
    // The user has unchecked "place a copy of the sent message..."
    fields.fcc = "";
  } else if (isReply && fccSameFolder) {
    // "Place a copy of sent messages in the folder of the message being replied
    // to..."
    let msgHdr = msgUriToMsgHdr(urls[0]);
    if (msgHdr.folder.canFileMessages) {
      fields.fcc = msgHdr.folder.URI;
    } else {
      fields.fcc = defaultFcc;
    }
  } else {
    fields.fcc = defaultFcc;
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
  let params = Cc[
    "@mozilla.org/messengercompose/composeparams;1"
  ].createInstance(Ci.nsIMsgComposeParams);
  params.composeFields = fields;
  params.identity = identity;
  params.type = compType;
  params.sendListener = sendListener;

  // If we want to switch to the external editor, we assembled all the
  //  composition fields properly. Pass them to a compose window, and move on.
  if (popOut) {
    let composeHtml = determineComposeHtml(identity);
    // We set all the fields ourselves, force New so that the compose code
    //  doesn't try to figure out the parameters by itself.
    fields.characterSet = "UTF-8";
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
      plainText(body) {
        if (composeHtml) {
          fields.body = plainTextToHtml(body);
        } else {
          fields.body = body;
        }
      },
      editor(iframe) {
        let html = iframe.contentDocument.body.innerHTML;
        if (composeHtml) {
          fields.body = html;
        } else {
          fields.body = htmlToPlainText(html);
        }
      },
    });

    params.format = composeHtml
      ? Ci.nsIMsgCompFormat.HTML
      : Ci.nsIMsgCompFormat.PlainText;
    fields.forcePlainText = !composeHtml;
    params.type = mCompType.New;
    MailServices.compose.OpenComposeWindowWithParams(null, params);
    return;
  }
  aBody.match({
    plainText(body) {
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
      // Strip trailing whitespace before wrapping, so as not to interpret it
      // as a f=f line continuation.
      fields.body = simpleWrap(body.replace(/ +$/gm, ""), 72) + "\n";
      let msgLineBreak = isWindows ? "\r\n" : "\n";
      fields.body = fields.body.replace(/\r?\n/g, msgLineBreak);

      // This part initializes a nsIMsgCompose instance. This is useless, because
      //  that component is supposed to talk to the "real" compose window, set the
      //  encoding, set the composition mode... we're only doing that because we
      //  can't send the message ourselves because of too many [noscript]s.
      gMsgCompose = initCompose(MailServices.compose, params);
    },

    editor(iframe) {
      fields.bodyIsAsciiOnly = false;
      fields.characterSet = "UTF-8";
      gMsgCompose = initCompose(
        MailServices.compose,
        params,
        null, // XXX put a real window here to see the notification window
        iframe.contentWindow.docshell
      );
      // Here we trust the parameters that have been set by the call to
      // msgComposeService.InitCompose above, and we just assume the
      // fakeEditor will be able to output HTML and plainText as needed...
      try {
        let fakeEditor = new FakeEditor(iframe);
        gMsgCompose.initEditor(fakeEditor, iframe.contentWindow);
      } catch (e) {
        // Recent Thunderbirds only.
        Log.debug(e);
        gMsgCompose.editor = getEditorForIframe(iframe);
      }
      let convertibility = gMsgCompose.bodyConvertible();
      Log.debug("This message might be convertible:", convertibility);
      switch (convertibility) {
        case Ci.nsIMsgCompConvertible.Plain: // 1
        case Ci.nsIMsgCompConvertible.Yes: // 2
        case Ci.nsIMsgCompConvertible.Altering: // 3
          fields.ConvertBodyToPlainText();
          fields.forcePlainText = true;
          fields.useMultipartAlternative = false;
          break;

        case Ci.nsIMsgCompConvertible.No: // 4
        default:
          fields.useMultipartAlternative = true;
          break;
      }
    },
  });

  // We create a progress listener...
  var progress = Cc["@mozilla.org/messenger/progress;1"].createInstance(
    Ci.nsIMsgProgress
  );
  if (progress && progressListener) {
    progress.registerListener(progressListener);
  }
  if (stateListener) {
    gMsgCompose.RegisterStateListener(stateListener);
  }

  try {
    gMsgCompose.SendMsg(deliverType, identity, "", null, progress);
  } catch (ex) {
    console.error(ex);
  }
}
