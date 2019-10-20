/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// First of all we need to setup a fake profile directory. This function is from
//  head.js and we're setting XPCSHELL_TEST_PROFILE_DIR from run.js
do_get_profile();

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
const { SimpleStorage } = ChromeUtils.import(
  "resource:///modules/SimpleStorage.js"
);

let remainingThreads = 0;

async function test_sync_api() {
  let ss = SimpleStorage.createIteratorStyle("test");
  let r;

  r = await ss.has("myKey");
  Assert.ok(!r);
  r = await ss.set("myKey", "myVal");
  Assert.ok(r); // Value was added
  r = await ss.get("myKey");
  Assert.equal(r, "myVal");

  let o = { k1: "v1", k2: "v2" };
  r = await ss.set("myKey", o);
  Assert.ok(!r); // Value was updated in-place
  r = await ss.get("myKey");
  for (let key of Object.keys(r)) {
    Assert.equal(r[key], o[key]);
  }
  for (let key of Object.keys(o)) {
    Assert.equal(r[key], o[key]);
  }

  r = await ss.has("myKey");
  Assert.ok(!r);
  dump("\033[01;34m--- async api test is over\033[00m\n");
  remainingThreads--;
}

add_task(async function run_tests() {
  remainingThreads++;
  await test_sync_api();

  let thread = Services.tm.currentThread;
  while (remainingThreads) {
    thread.processNextEvent(true);
  }

  dump("\033[01;35m--- test is over\033[00m\n");
});
