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
 *  Jonathan Protzenko <jonathan.protzenko@gmail.com>
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

// First of all we need to setup a fake profile directory. This function is from
//  head.js and we're setting XPCSHELL_TEST_PROFILE_DIR from run.js
do_get_profile();

const Ci = Components.interfaces;
const Cc = Components.classes;
const Cu = Components.utils;
const Cr = Components.results;

Cu.import("resource:///modules/SimpleStorage.js");

let remainingThreads = 0;

function test_sync_api () {
  spin(function () {
    let ss = new SimpleStorage("test");
    let r;

    r = yield ss.sHas("myKey");
    do_check_false(r);
    r = yield ss.sSet("myKey", "myVal");
    do_check_true(r);
    r = yield ss.sGet("myKey");
    do_check_true(r == "myVal");

    let o = { k1: "v1", k2: "v2" };
    r = yield ss.sSet("myKey", o);
    do_check_false(r);
    r = yield ss.sGet("myKey");
    for each (key in Object.keys(r))
      do_check_true(r[key] == o[key]);
    for each (key in Object.keys(o))
      do_check_true(r[key] == o[key]);

    r = yield ss.sRemove("myKey");
    do_check_true(r);
    r = yield ss.sRemove("myKey");
    do_check_false(r);
    r = yield ss.sHas("myKey");
    do_check_false(r);
    dump("\033[01;34m--- async api test is over\033[00m\n");
    remainingThreads--;
    yield kWorkDone;
  });
}

function run_tests () {
  remainingThreads++;
  test_sync_api();

  let thread = Components.classes["@mozilla.org/thread-manager;1"]
               .getService(Components.interfaces.nsIThreadManager)
               .currentThread;
  while (remainingThreads) {
    thread.processNextEvent(true);
  }

  dump("\033[01;35m--- test is over\033[00m\n");
}

run_tests();
