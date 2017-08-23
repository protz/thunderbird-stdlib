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
 * The Original Code is Mail utility functions for GMail Conversation View
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
 * @fileoverview This file provides various utilities: some helpers to deal with
 * identity management, some helpers for JS programming, some helpers for
 * low-level XPCOM stuff...
 * @author Jonathan Protzenko
 */

var EXPORTED_SYMBOLS = [
  // Identity management helpers
  'gIdentities', 'fillIdentities', 'getIdentities', 'getDefaultIdentity', 'getIdentityForEmail',
  // JS programming helpers
  'range', 'MixIn', 'combine', 'entries',
  // XPCOM helpers
  'NS_FAILED', 'NS_SUCCEEDED',
  // Various formatting helpers
  'dateAsInMessageList', 'escapeHtml', 'sanitize', 'parseMimeLine',
  // Useful for web content
  'encodeUrlParameters', 'decodeUrlParameters',
  // Character set helpers
  'systemCharset',
  // Platform-specific idioms
  'isOSX', 'isWindows', 'isAccel'
]

const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import("resource:///modules/iteratorUtils.jsm"); // for fixIterator
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/AppConstants.jsm");
Cu.import("resource:///modules/mailServices.js");

XPCOMUtils.importRelative(this, "../log.js");

let Log = setupLogging(logRoot+".Stdlib");

let isOSX = AppConstants.platform === "macosx";
let isWindows = AppConstants.platform === "win";

function isAccel (event) {
  return isOSX && event.metaKey || event.ctrlKey;
}

/**
 * Low-level XPCOM-style macro. You might need this for the composition and
 *  sending listeners which will pass you some status codes.
 * @param {Int} v The status code
 * @return {Bool}
 */
function NS_FAILED(v) {
  return (v & 0x80000000);
}

/**
 * Low-level XPCOM-style macro. You might need this for the composition and
 *  sending listeners which will pass you some status codes.
 * @param {Int} v The status code
 * @return {Bool}
 */
function NS_SUCCEEDED(v) {
  return !NS_FAILED(v);
}

/**
 * Python-style range function to use in list comprehensions.
 *  @param {Number} begin
 *  @param {Number} end
 *  @return {Generator} An iterator that yields from begin to end - 1.
 */
function* range(begin, end) {
  for (let i = begin; i < end; ++i) {
    yield i;
  }
}

/**
 * Helper function to simplify iteration over key/value store objects.
 * From https://esdiscuss.org/topic/es6-iteration-over-object-values
 * @param {Object} anObject
 */
function* entries(anObject) {
   for (let key of Object.keys(anObject)) {
     yield [key, anObject[key]];
   }
}

/**
 * MixIn-style helper. Adds aMixIn properties, getters and setters to
 *  aConstructor.
 * @param {Object} aConstructor
 * @param {Object} aMixIn
 */
function MixIn(aConstructor, aMixIn) {
  let proto = aConstructor.prototype;
  for (let [name, func] of entries(aMixIn)) {
    if (name.substring(0, 4) == "get_")
      proto.__defineGetter__(name.substring(4), func);
    else
      proto[name] = func;
  }
}

/**
 * A global pointer to all the identities known for the user. Feel free to call
 *  fillIdentities again if you feel that the user has updated them!
 * The keys are email addresses, the values are <tt>nsIMsgIdentity</tt> objects.
 *
 * @const
 */
let gIdentities = {};

/**
 * This function you should call to populate the gIdentities global object. The
 *  recommended time to call this is after the mail-startup-done event, although
 *  doing this at overlay load-time seems to be fine as well.
 * There is a "default" key, that we guarantee to be non-null, by picking the
 *  first account's first valid identity if the default account doesn't have any
 *  valid identity associated.
 * @param aSkipNntp (optional) Should we avoid including nntp identities in the
 *  list?
 * @deprecated Use getIdenties() instead
 */
function fillIdentities(aSkipNntp) {
  Log.warn("fillIdentities is deprecated! Use getIdentities instead!");
  Log.debug("Filling identities with skipnntp = ", aSkipNntp);

  for (let currentIdentity of getIdentities(aSkipNntp)) {
    gIdentities[currentIdentity.identity.email] = currentIdentity.identity;
    if (currentIdentity.isDefault) {
      gIdentities["default"] = currentIdentity.identity;
    }
  }

  if(!("default" in gIdentities)) {
    gIdentities["default"] = getIdentities()[0].identity;
  }
}

/**
 * Returns the default identity in the form { boolean isDefault; nsIMsgIdentity identity }
 */
function getDefaultIdentity() {
  return getIdentities().find(x => x.isDefault);
}

/**
 * Returns a list of all identities in the form [{ boolean isDefault; nsIMsgIdentity identity }].
 * It is assured that there is exactly one default identity.
 * If only the default identity is needed, getDefaultIdentity() can be used.
 * @param aSkipNntpIdentities (default: true) Should we avoid including nntp identities in the list?
 */
function getIdentities(aSkipNntpIdentities = true) {
  let identities = [];
  for (let account of fixIterator(MailServices.accounts.accounts, Ci.nsIMsgAccount)) {
    let server = account.incomingServer;
    if (aSkipNntpIdentities && (!server || server.type != "pop3" && server.type != "imap")) {
      continue;
    }
    for (let currentIdentity of fixIterator(account.identities, Ci.nsIMsgIdentity)) {
      // We're only interested in identities that have a real email.
      if (currentIdentity.email) {
        identities.push({ isDefault: (currentIdentity == MailServices.accounts.defaultAccount.defaultIdentity), identity: currentIdentity });
      }
    }
  }
  if (identities.length == 0) {
    Log.warn("Didn't find any identities!");
  }
  else {
    if (!identities.some(x => x.isDefault)) {
      Log.warn("Didn't find any default key - mark the first identity as default!");
      identities[0].isDefault = true;
    }
  }
  return identities;
}

/*
 * Searches a given email address in all identities and returns the corresponding identity.
 * @param {String} anEmailAddress Email address to be searched in the identities
 * @returns {{Boolean} isDefault, {{nsIMsgIdentity} identity} if found, otherwise undefined
 */
function getIdentityForEmail(anEmailAddress) {
  return getIdentities(false).find(ident => ident.identity.email.toLowerCase() == anEmailAddress.toLowerCase());
}

/**
 * A stupid formatting function that uses the i18nDateFormatter XPCOM component
 * to format a date just like in the message list
 * @param {Date} aDate a javascript Date object
 * @return {String} a string containing the formatted date
 */
function dateAsInMessageList(aDate) {
  let now = new Date();
  // Is it today?
  let isToday =
    now.getFullYear() == aDate.getFullYear() &&
    now.getMonth() == aDate.getMonth() &&
    now.getDate() == aDate.getDate();

  let format = isToday
    ? {timeStyle: "short"}
    : {dateStyle: "short", timeStyle: "short"};
  let dateTimeFormatter = Services.intl.createDateTimeFormat(undefined, format);
  return dateTimeFormatter.format(aDate);
}


const RE_SANITIZE = /[\u0000-\u0008\u000b-\u000c\u000e-\u001f]/g;

/**
 * Helper function to remove non-printable characters from a string -- injecting
 * these in an XML or XHTML document would cause an error.
 * @param {String} s input text
 * @param {String} The sanitized string.
 */
function sanitize(s) {
  return (s || "").replace(RE_SANITIZE, "");
}

/**
 * Helper function to escape some XML chars, so they display properly in
 *  innerHTML.
 * @param {String} s input text
 * @return {String} The string with &lt;, &gt;, and &amp; replaced by the corresponding entities.
 */
function escapeHtml(s) {
  s += "";
  // stolen from selectionsummaries.js (thanks davida!)
  return sanitize(s.replace(/[<>&]/g, function(s) {
      switch (s) {
        case "<": return "&lt;";
        case ">": return "&gt;";
        case "&": return "&amp;";
        default: throw Error("Unexpected match");
      }
    }
  ));
}

/**
 * Wraps the low-level header parser stuff.
 * @param {String} aMimeLine a line that looks like "John &lt;john@cheese.com&gt;, Jane &lt;jane@wine.com&gt;"
 * @param {Boolean} aDontFix (optional) Default to false. Shall we return an
 *  empty array in case aMimeLine is empty?
 * @return {Array} a list of { email, name } objects
 */
function parseMimeLine (aMimeLine, aDontFix) {
  if (aMimeLine == null) {
    Log.debug("Empty aMimeLine?!!");
    return [];
  }
  let emails = {};
  let fullNames = {};
  let names = {};
  let numAddresses = MailServices.headerParser.parseHeadersWithArray(aMimeLine,
                                                                     emails,
                                                                     names,
                                                                     fullNames);
  if (numAddresses)
    return [ ...range(0, numAddresses) ].map(i => {
      return { email: emails.value[i], name: names.value[i], fullName: fullNames.value[i] };
    });
  else if (aDontFix)
    return [];
  else
    return [{ email: "", name: "-", fullName: "-" }];
}

/**
 * Takes an object whose keys are the parameter names, whose values are strings
 * that are to be encoded in the url.
 * @param aObj
 * @return param1=val1&param2=val2 etc.
 */
function encodeUrlParameters(aObj) {
  let kv = [];
  for (let [k, v] of entries(aObj)) {
    kv.push(k+"="+encodeURIComponent(v));
  }
  return kv.join("&");
}

/**
 * Takes the <b>entire</b> query string and returns an object whose keys are the
 * parameter names and values are corresponding values.
 * @param aStr The entire query string
 * @return An object that holds the decoded data
 */
function decodeUrlParameters(aStr) {
  let params = {};
  let i = aStr.indexOf("?");
  if (i >= 0) {
    let query = aStr.substring(i+1, aStr.length);
    let keyVals = query.split("&");
    for (let keyVal of keyVals) {
      let [key, val] = keyVal.split("=");
      val = decodeURIComponent(val);
      params[key] = val;
    }
  }
  return params;
}

/**
 * Returns a system character set string, which is system code page on Windows,
 * LANG environment variable's encoding on Unix-like OS, otherwise UTF-8.
 * @return {String} a character set string
 */
function systemCharset() {
  let charset = "UTF-8";
  if ("@mozilla.org/windows-registry-key;1" in Cc) {
    let registry = Cc["@mozilla.org/windows-registry-key;1"]
                     .createInstance(Ci.nsIWindowsRegKey);
    registry.open(registry.ROOT_KEY_LOCAL_MACHINE,
                  "SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage",
                  registry.ACCESS_READ);
    let codePage = registry.readStringValue("ACP");
    if (codePage) {
      charset = "CP" + codePage;
    }
    registry.close();
  }
  else {
    let env = Cc["@mozilla.org/process/environment;1"]
                .getService(Ci.nsIEnvironment);
    let lang = env.get("LANG").split(".");
    if (lang.length > 1) {
      charset = lang[1];
    }
  }
  return charset;
}

function combine(a1, a2) {
  if (a1.length != a2.length)
    throw new Error("combine: the given arrays have different lengths");
  return [ ...range(0, a1.length) ].map(i => [a1[i], a2[i]]);
}
