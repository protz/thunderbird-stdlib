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
  'gIdentities', 'fillIdentities',
  // JS programming helpers
  'range', 'MixIn',
  // XPCOM helpers
  'NS_FAILED', 'NS_SUCCEEDED',
  // Various formatting helpers
  'dateAsInMessageList', 'escapeHtml', 'parseMimeLine',
]

const Ci = Components.interfaces;
const Cc = Components.classes;
const Cu = Components.utils;
Cu.import("resource:///modules/iteratorUtils.jsm"); // for fixIterator

const i18nDateFormatter = Cc["@mozilla.org/intl/scriptabledateformat;1"]
                            .createInstance(Ci.nsIScriptableDateFormat);
const headerParser = Cc["@mozilla.org/messenger/headerparser;1"]
                       .getService(Ci.nsIMsgHeaderParser);
const msgAccountManager = Cc["@mozilla.org/messenger/account-manager;1"]
                             .getService(Ci.nsIMsgAccountManager);

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
 *  @return {Iterator} An iterator that yields from begin to end - 1.
 */
function range(begin, end) {
  for (let i = begin; i < end; ++i) {
    yield i;
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
  for (let [name, func] in Iterator(aMixIn)) {
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
 * Beware, although gIdentities has a "default" key, it is not guaranteed to be
 *  non-null.
 */
function fillIdentities() {
  for each (let id in fixIterator(msgAccountManager.allIdentities, Ci.nsIMsgIdentity)) {
    gIdentities[id.email.toLowerCase()] = id;
  }
  gIdentities["default"] = msgAccountManager.defaultAccount.defaultIdentity;
}

/**
 * A stupid formatting function that uses the i18nDateFormatter XPCOM component
 * to format a date just like in the message list
 * @param {Date} aDate a javascript Date object
 * @return {String} a string containing the formatted date
 */
function dateAsInMessageList(aDate) {
  // Is it today? (Less stupid tests are welcome!)
  let format = aDate.toLocaleDateString("%x") == (new Date()).toLocaleDateString("%x")
    ? Ci.nsIScriptableDateFormat.dateFormatNone
    : Ci.nsIScriptableDateFormat.dateFormatShort;
  // That is an ugly XPCOM call!
  return i18nDateFormatter.FormatDateTime(
    "", format, Ci.nsIScriptableDateFormat.timeFormatNoSeconds,
    aDate.getFullYear(), aDate.getMonth() + 1, aDate.getDate(),
    aDate.getHours(), aDate.getMinutes(), aDate.getSeconds());
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
  return s.replace(/[<>&]/g, function(s) {
      switch (s) {
          case "<": return "&lt;";
          case ">": return "&gt;";
          case "&": return "&amp;";
          default: throw Error("Unexpected match");
          }
      }
  );
}

/**
 * Wraps the low-level header parser stuff.
 * @param {String} aMimeLine a line that looks like "John &lt;john@cheese.com&gt;, Jane &lt;jane@wine.com&gt;"
 * @return {Array} a list of { email, name } objects
 */
function parseMimeLine (aMimeLine) {
  let emails = {};
  let fullNames = {};
  let names = {};
  let numAddresses = headerParser.parseHeadersWithArray(aMimeLine, emails, names, fullNames);
  if (numAddresses)
    return [{ email: emails.value[i], name: names.value[i], fullName: fullNames.value[i] }
      for each (i in range(0, numAddresses))];
  else
    return [{ email: "", name: "-", fullName: "-" }];
}
