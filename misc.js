/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @fileoverview This file provides various utilities: some helpers to deal with
 * identity management, some helpers for JS programming, some helpers for
 * low-level XPCOM stuff...
 * @author Jonathan Protzenko
 */

var EXPORTED_SYMBOLS = [
  // Identity management helpers
  "getIdentities",
  "getDefaultIdentity",
  "getIdentityForEmail",
  // JS programming helpers
  "range",
  // Various formatting helpers
  "dateAsInMessageList",
  "escapeHtml",
  "parseMimeLine",
  // Character set helpers
  "systemCharset",
];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

XPCOMUtils.defineLazyModuleGetters(this, {
  fixIterator: "resource:///modules/iteratorUtils.jsm",
  MailServices: "resource:///modules/MailServices.jsm",
  Services: "resource://gre/modules/Services.jsm",
});

if (!Services.intl) {
  // That one doesn't belong to MailServices.
  XPCOMUtils.defineLazyServiceGetter(
    MailServices,
    "i18nDateFormatter",
    "@mozilla.org/intl/scriptabledateformat;1",
    "nsIScriptableDateFormat"
  );
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
  for (let account of fixIterator(
    MailServices.accounts.accounts,
    Ci.nsIMsgAccount
  )) {
    let server = account.incomingServer;
    if (
      aSkipNntpIdentities &&
      (!server || (server.type != "pop3" && server.type != "imap"))
    ) {
      continue;
    }
    const defaultIdentity = MailServices.accounts.defaultAccount
      ? MailServices.accounts.defaultAccount.defaultIdentity
      : null;
    for (let currentIdentity of fixIterator(
      account.identities,
      Ci.nsIMsgIdentity
    )) {
      // We're only interested in identities that have a real email.
      if (currentIdentity.email) {
        identities.push({
          isDefault: currentIdentity == defaultIdentity,
          identity: currentIdentity,
        });
      }
    }
  }
  if (!identities.length) {
    console.warn("Didn't find any identities!");
  } else if (!identities.some(x => x.isDefault)) {
    console.warn(
      "Didn't find any default key - mark the first identity as default!"
    );
    identities[0].isDefault = true;
  }
  return identities;
}

/*
 * Searches a given email address in all identities and returns the corresponding identity.
 * @param {String} anEmailAddress Email address to be searched in the identities
 * @returns {{Boolean} isDefault, {{nsIMsgIdentity} identity} if found, otherwise undefined
 */
function getIdentityForEmail(anEmailAddress) {
  return getIdentities(false).find(
    ident => ident.identity.email.toLowerCase() == anEmailAddress.toLowerCase()
  );
}

/**
 * A stupid formatting function that uses the i18nDateFormatter XPCOM component
 * to format a date just like in the message list
 * @param {Date} aDate a javascript Date object
 * @return {String} a string containing the formatted date
 */
function dateAsInMessageList(aDate) {
  const now = new Date();
  // Is it today?
  const isToday =
    now.getFullYear() == aDate.getFullYear() &&
    now.getMonth() == aDate.getMonth() &&
    now.getDate() == aDate.getDate();

  const format = isToday
    ? { timeStyle: "short" }
    : { dateStyle: "short", timeStyle: "short" };
  const dateTimeFormatter = new Services.intl.DateTimeFormat(undefined, format);
  return dateTimeFormatter.format(aDate);
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
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      default:
        throw Error("Unexpected match");
    }
  });
}

/**
 * Wraps the low-level header parser stuff.
 * @param {String} mimeLine
 *   A line that looks like "John &lt;john@cheese.com&gt;, Jane &lt;jane@wine.com&gt;"
 * @param {Boolean} [dontFix]
 *   Defaults to false. Shall we return an empty array in case aMimeLine is empty?
 * @return {Array}
 *   A list of { email, name } objects
 */
function parseMimeLine(mimeLine, dontFix) {
  if (mimeLine == null) {
    console.debug("Empty aMimeLine?!!");
    return [];
  }
  // The null here copes with pre-Thunderbird 71 compatibility.
  let addresses = MailServices.headerParser.parseEncodedHeader(mimeLine, null);
  if (addresses.length) {
    return addresses.map(addr => {
      return {
        email: addr.email,
        name: addr.name,
        fullName: addr.toString(),
      };
    });
  }
  if (dontFix) {
    return [];
  }
  return [{ email: "", name: "-", fullName: "-" }];
}

/**
 * Returns a system character set string, which is system code page on Windows,
 * LANG environment variable's encoding on Unix-like OS, otherwise UTF-8.
 * @return {String} a character set string
 */
function systemCharset() {
  let charset = "UTF-8";
  if ("@mozilla.org/windows-registry-key;1" in Cc) {
    let registry = Cc["@mozilla.org/windows-registry-key;1"].createInstance(
      Ci.nsIWindowsRegKey
    );
    registry.open(
      registry.ROOT_KEY_LOCAL_MACHINE,
      "SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage",
      registry.ACCESS_READ
    );
    let codePage = registry.readStringValue("ACP");
    if (codePage) {
      charset = "CP" + codePage;
    }
    registry.close();
  } else {
    let env = Cc["@mozilla.org/process/environment;1"].getService(
      Ci.nsIEnvironment
    );
    let lang = env.get("LANG").split(".");
    if (lang.length > 1) {
      charset = lang[1];
    }
  }
  return charset;
}
