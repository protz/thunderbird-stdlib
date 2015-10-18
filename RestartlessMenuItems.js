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
 * The Original Code is about:telemetry integration code for Thunderbird
 *
 * The Initial Developer of the Original Code is
 *  Jonathan Protzenko <jonathan.protzenko@gmail.com>
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *  Szabolcs Hubai <szab.hu@gmail.com>
 *  Mike Hommey <mh@glandium.org>
 *  Erik Vold <erikvvold@gmail.com>
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
 * @fileoverview Provides a wrapper for easily adding and 
 *  removing menu items in a restartless fashion.
 * @author Jonathan Protzenko
 */
 
var EXPORTED_SYMBOLS = ['RestartlessMenuItems'];

const {classes: Cc, interfaces: Ci, utils: Cu} = Components; 

Cu.import("resource://gre/modules/Services.jsm");

let _menuItems = [];

function isThunderbird()
{
  let APP_ID = Services.appinfo.QueryInterface(Ci.nsIXULRuntime).ID;
  return APP_ID == "{3550f703-e582-4d05-9a08-453d09bdfdc6}";
}

var global = this;

/**
 * Adds a menuitem to a window.
 * @param w {nsIDOMWindow} A window to patch.
 * @param loadedAlready {bool} The window above is fully loaded, 
 *  or we should wait to be loaded.
 * @param options {Object} Options for the <tt>menuitem</tt>, with the following parameters:
 * @param options.id {String} An id for the <tt>menuitem</tt>, this should be namespaced.
 * @param options.label {String} A label for the <tt>menuitem</tt>.
 * @param options.url {String} (optional, preferred) An URL where the <tt>oncommand</tt> should navigate to.
 * @param options.onCommand {String} (optional) A function callback what the <tt>menuitem</tt>'s oncommand will call.
 * @param options.accesskey {String} (optional) An access key for the <tt>menuitem</tt>.
 * @param options.key {String} (optional) A shortcut key for the <tt>menuitem</tt>.
 * @param options.image {String} (optional) An URL for the <tt>menuitem</tt>.
 */
function monkeyPatchWindow(w, loadedAlready, options) {
  let doIt = function () {
    let id = options.id;
    let taskPopup = w.document.getElementById("taskPopup");
    let tabmail = w.document.getElementById("tabmail");
    let oldMenuitem = w.document.getElementById(id);

    // Check the windows is a mail:3pane
    if (!taskPopup || !tabmail)
      return;

    let openTabUrl = function() {
      return (options.url) ?
        tabmail.openTab("contentTab",
          { contentPage: options.url }
        )
        : false;
    };
    
    let onCmd = function() {
      openTabUrl() || options.onCommand && options.onCommand();
    };

    let menuitem = w.document.createElement("menuitem");
    menuitem.addEventListener("command", onCmd, false);
    menuitem.setAttribute("label", options.label);
    menuitem.setAttribute("id", id);
    if (options.accesskey)
      menuitem.setAttribute("accesskey", options.accesskey);
    if (options.key)
      menuitem.setAttribute("key", options.key);
    if (options.image) {
      menuitem.setAttribute("class", "menuitem-iconic");
      menuitem.style.listStyleImage = "url('" + options.image + "')";
    }
    if (!oldMenuitem)
      taskPopup.appendChild(menuitem);
    else
      taskPopup.replaceChild(menuitem, oldMenuitem);
  };
  if (loadedAlready)
    doIt();
  else
    w.addEventListener("load", doIt, false);
}

/**
 * Removes a menuitem from a window.
 * @param w {nsIDOMWindow} A window to patch.
 * @param options {Object} Options for the <tt>menuitem</tt>, with the following parameter:
 * @param options.id {String} An id for the <tt>menuitem</tt>, this should be namespaced.
 * @param options.url {String} (optional) An URL for the <tt>menuitem</tt>, tabs with this URL will be closed.
 * @param options.onUnload {Function} (optional) A function for the <tt>menuitem</tt>, which redoes all the stuff
 *  except the removing of menuitem.
 */
function unMonkeyPatchWindow(w, options) {
  let id = options.id;
  let menuitem = w.document.getElementById(id);
  let tabmail = w.document.getElementById("tabmail");

  // Remove all menuitem with this id
  while (menuitem) {
    menuitem.parentNode.removeChild(menuitem);
    menuitem = w.document.getElementById(id);
  }

  // Close all tab with options.url URL
  let removeTabUrl = function() {
    let tabMode = tabmail.tabModes["contentTab"];
    let shouldSwitchToFunc = tabMode.shouldSwitchTo ||
                            tabMode.tabType.shouldSwitchTo;

    if (shouldSwitchToFunc) {
      let tabIndex = shouldSwitchToFunc.apply(tabMode.tabType, [{ contentPage: options.url }]);
      while (tabIndex >= 0) {
        tabmail.closeTab(tabIndex, true);
        tabIndex = shouldSwitchToFunc.apply(tabMode.tabType, [{ contentPage: options.url }]);
      }
    }
  };

  if (options.url)
    removeTabUrl();
  else
    options.onUnload && options.onUnload();
}

/**
 * This is Our observer. It catches the newly opened windows
 *  and tries to run the patcher on them.
 * @observes "domwindowopened"
 *
 * @prop observe An nsIWindowWatcher will notify this method. It will call the {@link monkeyPatchWindow}.
 * @prop register Start listening to notifications.
 * @prop unregister Stop listening to notifications.
 */
function monkeyPatchWindowObserver() {};

monkeyPatchWindowObserver.prototype = {
  observe: function (aSubject, aTopic, aData) {
    if (aTopic == "domwindowopened") {
      aSubject.QueryInterface(Ci.nsIDOMWindow);
      for (let aMenuItem of _menuItems)
        monkeyPatchWindow(aSubject.window, false, aMenuItem);
    }
  },
  register: function() {
    Services.ww.registerNotification(this);
  },
  unregister: function() {
    Services.ww.unregisterNotification(this);
  }
}

/**
 * This is the observer Object.
 */
let monkeyPatchFutureWindow = new monkeyPatchWindowObserver();

/**
 * This is the public interface of the RestartlessMenuItems module.
 * 
 * @prop add Adds a parameterized <tt>menuitem</tt> to existing and 
 *  newly created windows.
 * @prop remove Removes an identified <tt>menuitem</tt> from 
 *  existing window, and will not add to new ones.
 * @prop removeAll Removes all the <tt>menuitem</tt>s currently added.
 */
var RestartlessMenuItems = {
  add: function _RestartlessMenuItems_add (options) {
    // For Thunderbird, since there's no URL bar, we add a menu item to make it
    // more discoverable.
    if (isThunderbird()) {
      // Thunderbird-specific JSM
      Cu.import("resource:///modules/iteratorUtils.jsm", global);

      // Push it to our list
      _menuItems.push(options);

      // Patch all existing windows
      for (let w of fixIterator(Services.wm.getEnumerator("mail:3pane"), Ci.nsIDOMWindow)) {
        // True means the window's been loaded already, so add the menu item right
        // away (the default is: wait for the "load" event).
        monkeyPatchWindow(w.window, true, options);
      }

      // Patch all future windows 
      // with our list of menuItems
      if (_menuItems.length == 1)
        monkeyPatchFutureWindow.register();
    }
  },

  remove: function _RestartlessMenuItems_remove (options, keepArray) {
    if (isThunderbird()) {
      // Find the menuitem in our list by id
      let found = false;
      let index = -1;
      found = _menuItems.some( function isOurMenuItem (element, arrayIndex){
        if (element.id == options.id)
          index = arrayIndex;
        return (element.id == options.id);
      });
      
      // Un-patch all existing windows
      if (found)
        for (let w of fixIterator(Services.wm.getEnumerator("mail:3pane")))
          unMonkeyPatchWindow(w, _menuItems[index]);

      if (!keepArray) {
        // Pop out from our list
        if (found)
          _menuItems.splice(index, 1);

        // Stop patching future windows if our list is empty
        if (_menuItems.length == 0)
          monkeyPatchFutureWindow.unregister();
      }
    }
  },

  removeAll: function _RestartlessMenuItems_removeAll () {
    if (isThunderbird()) {
      // Remove all added menuitems
      for (let aMenuItem of _menuItems)
        this.remove(aMenuItem, true);
      _menuItems = [];
      monkeyPatchFutureWindow.unregister();
    }
  },

};
