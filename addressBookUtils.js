/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @fileoverview This small file provides conveniences wrappers around legacy
 * address book interfaces.
 * @author Jonathan Protzenko
 */

var EXPORTED_SYMBOLS = [
  "kPersonalAddressBookUri",
  "kCollectedAddressBookUri",
  "getAddressBookFromUri",
  "saveEmailInAddressBook"
];

const abManager = Cc["@mozilla.org/abmanager;1"].getService(Ci.nsIAbManager);

/**
 * The "Personal addresses" address book
 * @const
 */
const kPersonalAddressBookUri = "moz-abmdbdirectory://abook.mab";
/**
 * The "Collected addresses" address book
 * @const
 */
const kCollectedAddressBookUri = "moz-abmdbdirectory://history.mab";

/**
 * Get one of the predefined address books through their URI.
 * @param aUri the URI of the address book, use one of the consts above
 * @return nsIAbDirectory the address book
 */
function getAddressBookFromUri(aUri) {
  return abManager.getDirectory(aUri);
}

/**
 * Just a one-liner to add an email to the given address book, without any extra
 *  properties.
 * @param aBook the nsIAbDirectory
 * @param aEmail the email
 * @param aName (optional) the name
 * @return nsIAbCard
 */
function saveEmailInAddressBook(aBook, aEmail, aName) {
  let card = Cc["@mozilla.org/addressbook/cardproperty;1"].createInstance(
    Ci.nsIAbCard
  );
  // card.setProperty("FirstName", "John");
  // card.setProperty("LastName", "Smith");
  card.displayName = aName;
  card.primaryEmail = aEmail;
  card.setProperty("AllowRemoteContent", true);
  return aBook.addCard(card);
}
