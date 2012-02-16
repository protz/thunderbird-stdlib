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
 * The Original Code is ............
 *
 * The Initial Developer of the Original Code is
 *  Jonathan Protzenko <jonathan.protzenko@gmail.com>
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Szabolcs Hubai <szab.hu@gmail.com> 
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
 * @fileoverview ........
 * @author Jonathan Protzenko
 */
 
let EXPORTED_SYMBOLS = ['patchTBWindow'];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cm = Components.manager;

Cu.import("resource://gre/modules/Services.jsm");

let patchTBWindow = {};

let _menuItem = null;

function isThunderbird()
{
  let APP_ID = Services.appinfo.QueryInterface(Ci.nsIXULRuntime).ID;
  return APP_ID == "{3550f703-e582-4d05-9a08-453d09bdfdc6}";
}

var global = this;

function monkeyPatchWindow(w, loadedAlready) {
  let doIt = function () {
    let taskPopup = w.document.getElementById("taskPopup");
    let tabmail = w.document.getElementById("tabmail");
    let menuitem = w.document.getElementById(_menuItem.id);

    // Check the windows is a mail:3pane
    // and should be patched or not
    if (!taskPopup || !tabmail || menuitem)
      return;

    menuitem = w.document.createElement("menuitem");
    menuitem.addEventListener("command", function () {
      w.document.getElementById("tabmail").openTab(
        "contentTab",
        { contentPage: _menuItem.url }
      );
    }, false);
    menuitem.setAttribute("label", _menuItem.label);
    menuitem.setAttribute("id", _menuItem.id);
    taskPopup.appendChild(menuitem);
  };
  if (loadedAlready)
    doIt();
  else
    w.addEventListener("load", doIt, false);
}

function unMonkeyPatchWindow(w) {
  let menuitem = w.document.getElementById(_menuItem.id);
  menuitem.parentNode.removeChild(menuitem);
}

function startup(options) {
  _menuItem = options.menuItem;
  
  // For Thunderbird, since there's no URL bar, we add a menu item to make it
  // more discoverable.
  if (isThunderbird()) {
    // Thunderbird-specific JSM
    Cu.import("resource:///modules/iteratorUtils.jsm", global);

    // Patch all existing windows
    for each (let w in fixIterator(Services.wm.getEnumerator("mail:3pane"), Ci.nsIDOMWindow)) {
      // True means the window's been loaded already, so add the menu item right
      // away (the default is: wait for the "load" event).
      monkeyPatchWindow(w.window, true);
    }

    // Patch all future windows
    Services.ww.registerNotification({
      observe: function (aSubject, aTopic, aData) {
        if (aTopic == "domwindowopened") {
          aSubject.QueryInterface(Ci.nsIDOMWindow);
          monkeyPatchWindow(aSubject.window);
        }
      },
    });
  }
}

function shutdown() {
  if (isThunderbird) {
    // Un-patch all existing windows
    for each (let w in fixIterator(Services.wm.getEnumerator("mail:3pane")))
      unMonkeyPatchWindow(w);
    
    _menuItem = null;
  }
}

patchTBWindow.startup = startup;
patchTBWindow.shutdown = shutdown;
