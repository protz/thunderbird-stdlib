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
 * @fileoverview Composition-related utils: quoting, wrapping text before
 *  sending a message, converting back and forth between HTML and plain text...
 * @author Jonathan Protzenko
 */

var EXPORTED_SYMBOLS = [
  'quoteMsgHdr', 'citeString',
  'htmlToPlainText', 'simpleWrap',
  'plainTextToHtml', 'replyAllParams',
  'determineComposeHtml',
]

const {classes: Cc, interfaces: Ci, utils: Cu, results : Cr} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm"); // for generateQI, defineLazyServiceGetter
Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource:///modules/gloda/mimemsg.js"); // For MsgHdrToMimeMessage

Cu.import("resource://conversations/stdlib/misc.js");
Cu.import("resource://conversations/stdlib/msgHdrUtils.js");
Cu.import("resource://conversations/log.js");

let Log = setupLogging(logRoot+".Stdlib");

let MailServices = {};
try {
  Cu.import("resource:///modules/mailServices.js");
} catch(ignore) {
  // backwards compatability for pre mailServices code, may not be necessary
  XPCOMUtils.defineLazyServiceGetter(MailServices, "headerParser",
                                     "@mozilla.org/messenger/headerparser;1",
                                     "nsIMsgHeaderParser");
}

/**
 * Use the mailnews component to stream a message, and process it in a way
 *  that's suitable for quoting (strip signature, remove images, stuff like
 *  that).
 * @param {nsIMsgDBHdr} aMsgHdr The message header that you want to quote
 * @param {Function} k The continuation. This function will be passed quoted
 *  text suitable for insertion in an HTML editor. You can pass this to
 *  htmlToPlainText if you're running a plaintext editor.
 * @return
 */
function quoteMsgHdr(aMsgHdr, k) {
  let chunks = [];
  // Everyone knows that nsICharsetConverterManager and nsIUnicodeDecoder
  //  are not to be used from scriptable code, right? And the error you'll
  //  get if you try to do so is really meaningful, and that you'll have no
  //  trouble figuring out where the error comes from...
  let unicodeConverter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                         .createInstance(Ci.nsIScriptableUnicodeConverter);
  unicodeConverter.charset = "UTF-8";
  let listener = {
    /**@ignore*/
    setMimeHeaders: function () {
    },

    /**@ignore*/
    onStartRequest: function (/* nsIRequest */ aRequest, /* nsISupports */ aContext) {
    },

    /**@ignore*/
    onStopRequest: function (/* nsIRequest */ aRequest, /* nsISupports */ aContext, /* int */ aStatusCode) {
      let data = chunks.join("");
      k(data);
    },

    /**@ignore*/
    onDataAvailable: function (/* nsIRequest */ aRequest, /* nsISupports */ aContext,
        /* nsIInputStream */ aStream, /* int */ aOffset, /* int */ aCount) {
      // Fortunately, we have in Gecko 2.0 a nice wrapper
      let data = NetUtil.readInputStreamToString(aStream, aCount);
      // Now each character of the string is actually to be understood as a byte
      //  of a UTF-8 string.
      // So charCodeAt is what we want here...
      let array = [];
      for (let i = 0; i < data.length; ++i)
        array[i] = data.charCodeAt(i);
      // Yay, good to go!
      chunks.push(unicodeConverter.convertFromByteArray(array, array.length));
    },

    QueryInterface: XPCOMUtils.generateQI([Ci.nsISupports, Ci.nsIStreamListener,
      Ci.nsIMsgQuotingOutputStreamListener, Ci.nsIRequestObserver])
  };
  // Here's what we want to stream...
  let msgUri = msgHdrGetUri(aMsgHdr);
  /**
   * Quote a particular message specified by its URI.
   *
   * @param charset optional parameter - if set, force the message to be
   *                quoted using this particular charset
   */
  //   void quoteMessage(in string msgURI, in boolean quoteHeaders,
  //                     in nsIMsgQuotingOutputStreamListener streamListener,
  //                     in string charset, in boolean headersOnly);
  let quoter = Cc["@mozilla.org/messengercompose/quoting;1"]
               .createInstance(Ci.nsIMsgQuote);
  quoter.quoteMessage(msgUri, false, listener, "", false);
}

/**
 * A function that properly quotes a plaintext email.
 * @param {String} aStr The mail body that we're expected to quote.
 * @return {String} The quoted mail body with &gt;'s properly taken care of.
 */
function citeString(aStr) {
  let l = aStr.length;
  return aStr.replace("\n", function (match, offset, str) {
    // http://mxr.mozilla.org/comm-central/source/mozilla/editor/libeditor/text/nsInternetCiter.cpp#96
    if (offset < l) {
      if (str[offset+1] != ">")
        return "\n> ";
      else
        return "\n>";
    }
  }, "g");
}

/**
 * Wrap some text. Beware, that function doesn't do rewrapping, and only
 *  operates on non-quoted lines. This is only useful in our very specific case
 *  where the quoted lines have been properly wrapped for format=flowed already,
 *  and the non-quoted lines are the only ones that need wrapping for
 *  format=flowed.
 * Beware, this function will treat all lines starting with >'s as quotations,
 *  even user-inserted ones. We would need support from the editor to proceed
 *  otherwise, and the current textarea doesn't provide this.
 * This function, when breaking lines, will do space-stuffing per the RFC if
 *  after the break the text starts with From or &gt;.
 * @param {String} txt The text that should be wrapped.
 * @param {Number} width (optional) The width we should wrap to. Default to 72.
 * @return {String} The text with non-quoted lines wrapped. This is suitable for
 *  sending as format=flowed.
 */
function simpleWrap(txt, width) {
  if (!width)
    width = 72;

  function maybeEscape(line) {
    if (line.indexOf("From") === 0 || line.indexOf(">") === 0)
      return (" " + line);
    else
      return line;
  }

  function splitLongLine(soFar, remaining) {
    if (remaining.length > width) {
      let i = width - 1;
      while (remaining[i] != " " && i > 0)
        i--;
      if (i > 0) {
        // This includes the trailing space that indicates that we are wrapping
        //  a long line with format=flowed.
        soFar.push(maybeEscape(remaining.substring(0, i+1)));
        return splitLongLine(soFar, remaining.substring(i+1, remaining.length));
      } else {
        let j = remaining.indexOf(" ");
        if (j > 0) {
          // Same remark.
          soFar.push(maybeEscape(remaining.substring(0, j+1)));
          return splitLongLine(soFar, remaining.substring(j+1, remaining.length));
        } else {
          // Make sure no one interprets this as a line continuation.
          soFar.push(remaining.trimRight());
          return soFar.join("\n");
        }
      }
    } else {
      // Same remark.
      soFar.push(maybeEscape(remaining.trimRight()));
      return soFar.join("\n");
    }
  }

  let lines = txt.split(/\r?\n/);

  for each (let [i, line] in Iterator(lines)) {
    if (line.length > width && line[0] != ">")
      lines[i] = splitLongLine([], line);
  }
  return lines.join("\n");
}

/**
 * Convert HTML into text/plain suitable for insertion right away in the mail
 *  body. If there is text with &gt;'s at the beginning of lines, these will be
 *  space-stuffed, and the same goes for Froms. &lt;blockquote&gt;s will be converted
 *  with the suitable &gt;'s at the beginning of the line, and so on...
 * This function also takes care of rewrapping at 72 characters, so your quoted
 *  lines will be properly wrapped too. This means that you can add some text of
 *  your own, and then pass this to simpleWrap, it should "just work" (unless
 *  the user has edited a quoted line and made it longer than 990 characters, of
 *  course).
 * @param {String} aHtml A string containing the HTML that's to be converted.
 * @return {String} A text/plain string suitable for insertion in a mail body.
 */
function htmlToPlainText(aHtml) {
  // Yes, this is ridiculous, we're instanciating composition fields just so
  //  that they call ConvertBufPlainText for us. But ConvertBufToPlainText
  //  really isn't easily scriptable, so...
  let fields = Cc["@mozilla.org/messengercompose/composefields;1"]
                  .createInstance(Ci.nsIMsgCompFields);
  fields.body = aHtml;
  fields.forcePlainText = true;
  fields.ConvertBodyToPlainText();
  return fields.body;
}

/**
 * @ignore
 */
function citeLevel (line) {
  let i;
  for (i = 0; line[i] == ">" && i < line.length; ++i)
    ; // nop
  return i;
};

/**
 * Just try to convert quoted lines back to HTML markup (&lt;blockquote&gt;s).
 * @param {String} txt
 * @return {String}
 */
function plainTextToHtml(txt) {
  let lines = txt.split(/\r?\n/);
  let newLines = [];
  let level = 0;
  for each (let [, line] in Iterator(lines)) {
    let newLevel = citeLevel(line);
    if (newLevel > level)
      for (let i = level; i < newLevel; ++i)
        newLines.push('<blockquote type="cite">');
    if (newLevel < level)
      for (let i = newLevel; i < level; ++i)
        newLines.push('</blockquote>');
    let newLine = line[newLevel] == " "
      ? escapeHtml(line.substring(newLevel + 1, line.length))
      : escapeHtml(line.substring(newLevel, line.length))
    ;
    newLines.push(newLine);
    level = newLevel;
  }
  return newLines.join("\n");
}

function parse(aMimeLine) {
  let emails = {};
  let fullNames = {};
  let names = {};
  let numAddresses = MailServices.headerParser.parseHeadersWithArray(aMimeLine, emails, names, fullNames);
  return [names.value, emails.value];
}

/**
 * Analyze a message header, and then return all the compose parameters for the
 * reply-all case.
 * @param {nsIIdentity} The identity you've picked for the reply.
 * @param {nsIMsgDbHdr} The message header.
 * @param {k} The function to call once we've determined all parameters. Take an
 *  argument like
 *  {{ to: [[name, email]], cc: [[name, email]], bcc: [[name, email]]}}
 */
function replyAllParams(aIdentity, aMsgHdr, k) {
  // Do the whole shebang to find out who to send to...
  let [[author], [authorEmailAddress]] = parse(aMsgHdr.mime2DecodedAuthor);
  let [recipients, recipientsEmailAddresses] = parse(aMsgHdr.mime2DecodedRecipients);
  let [ccList, ccListEmailAddresses] = parse(aMsgHdr.ccList);
  let [bccList, bccListEmailAddresses] = parse(aMsgHdr.bccList);
  authorEmailAddress = authorEmailAddress.toLowerCase();
  recipientsEmailAddresses = [x.toLowerCase()
    for each ([, x] in Iterator(recipientsEmailAddresses))];
  ccList = [x.toLowerCase() for each ([, x] in Iterator(ccList))];
  bccList = [x.toLowerCase() for each ([, x] in Iterator(bccList))];
  let identity = aIdentity;
  let to = [], cc = [], bcc = [];

  let isReplyToOwnMsg = false;
  for each (let [i, identity] in Iterator(gIdentities)) {
    // It happens that gIdentities.default is null!
    if (!identity) {
      Log.debug("This identity is null, pretty weird...");
      continue;
    }
    let email = identity.email.toLowerCase();
    if (email == authorEmailAddress)
      isReplyToOwnMsg = true;
    if (recipientsEmailAddresses.some(function (x) x == email))
      isReplyToOwnMsg = false;
    if (ccListEmailAddresses.some(function (x) x == email))
      isReplyToOwnMsg = false;
  }

  // Actually we are implementing the "Reply all" logic... that's better, no one
  //  wants to really use reply anyway ;-)
  if (isReplyToOwnMsg) {
    to = [[r, recipientsEmailAddresses[i]]
      for each ([i, r] in Iterator(recipients))];
  } else {
    to = [[author, authorEmailAddress]];
  }
  cc = [[cc, ccListEmailAddresses[i]]
    for each ([i, cc] in Iterator(ccList))
    if (ccListEmailAddresses[i] != identity.email)];
  if (!isReplyToOwnMsg)
    cc = cc.concat
      ([[r, recipientsEmailAddresses[i]]
        for each ([i, r] in Iterator(recipients))
        if (recipientsEmailAddresses[i] != identity.email)]);
  bcc = [[bcc, bccListEmailAddresses[i]]
    for each ([i, bcc] in Iterator(bccList))];

  let finish = function (to, cc, bcc) {
    let hashMap = {};
    hashMap[to[0][1]] = null;
    cc = cc.filter(function ([name, email])
      let (r = (email in hashMap))
      (hashMap[email] = null,
      !r)
    );
    bcc = bcc.filter(function ([name, email])
      let (r = (email in hashMap))
      (hashMap[email] = null,
      !r)
    );
    k({ to: to, cc: cc, bcc: bcc });
  }

  // Do we have a Reply-To header?
  MsgHdrToMimeMessage(aMsgHdr, null, function (aMsgHdr, aMimeMsg) {
    if ("reply-to" in aMimeMsg.headers) {
      let [[name], [email]] = parse(aMimeMsg.headers["reply-to"]);
      if (email) {
        cc = cc.concat([to[0]]); // move the to in cc
        to = [[name, email]];
      }
    }
    finish(to, cc, bcc);
  }, true, {
    partsOnDemand: true,
  }); // do download
}

/**
 * This function replaces nsMsgComposeService::determineComposeHTML, which is
 * marked as [noscript], just to make our lives complicated. [insert random rant
 * here].
 *
 * @param aIdentity (optional) You can specify the identity which you would like
 * to get the preference for.
 * @return a bool which is true if you should compose in HTML
 */
function determineComposeHtml(aIdentity) {
  if (!aIdentity)
    aIdentity = gIdentities.default;

  if (aIdentity) {
    return (aIdentity.composeHtml == Ci.nsIMsgCompFormat.HTML);
  } else {
    return Cc["@mozilla.org/preferences-service;1"]
            .getService(Ci.nsIPrefService)
            .getBranch(null)
            .getBoolPref("mail.compose_html");
  }
}
