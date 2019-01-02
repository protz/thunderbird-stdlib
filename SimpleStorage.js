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

/**
 * @fileoverview This file exports the SimpleStorage wrapper around mozStorage.
 *  It is designed to help you use mozStorage is a simple get/set/has/remove
 *  API.
 * @author Jonathan Protzenko
 */

var EXPORTED_SYMBOLS = ["SimpleStorage"];

const {Sqlite} = ChromeUtils.import("resource://gre/modules/Sqlite.jsm", null);
const {OS} = ChromeUtils.import("resource://gre/modules/osfile.jsm", null);

Cu.importGlobalProperties(["URL"]);

let Log;
try {
  const {logRoot, setupLogging} = ChromeUtils.import(new URL("../log.js", this.__URI__), null);
  Log = setupLogging(logRoot + ".SimpleStorage");
  Log.debug("Simple Storage loaded.");
} catch (err) {
  Log = {error: () => {}, debug: () => {}};
}

const FILE_SIMPLE_STORAGE = "simple_storage.sqlite";

/**
 * The global SimpleStorage object. It has various method to instanciate a
 *  storage session with a given style. You should not have two different styles
 *  of API open at the same time on the same table.
 * @namespace
 */
var SimpleStorage = {
  async openConnection() {
    if (!this._dbConnection) {
      this._dbConnection = await Sqlite.openConnection({
        path: OS.Path.join(OS.Constants.Path.profileDir, FILE_SIMPLE_STORAGE),
      });
    }
  },

  async get(tableName, key) {
    if (!this._dbConnection) {
      await this._ensureTable(tableName);
    }

    let rows = await this._dbConnection.execute(
      "SELECT value FROM #1 WHERE key = :key".replace("#1", tableName),
      {key}
    );

    if (rows.length > 1) {
      Log.assert(false, "Multiple rows for the same primary key? That's impossible!");
      return null;
    }

    if (rows.length == 1) {
      return JSON.parse(rows[0].getResultByName("value")).value;
    }
    return null;
  },

  async set(tableName, key, value) {
    if (!this._dbConnection) {
      await this._ensureTable(tableName);
    }

    await this._dbConnection.executeBeforeShutdown("SimpleStorage:set", async db => {

      let query = await this.hasKey(tableName, key) ?
        "UPDATE #1 SET value = :value WHERE key = :key" :
        "INSERT INTO #1 (key, value) VALUES (:key, :value)";

      await db.execute(query.replace("#1", tableName), {
        key, value: JSON.stringify({ value }),
      });
    });
  },

  async remove(tableName, key) {
    if (!this._dbConnection) {
      await this._ensureTable(tableName);
    }

    await this._dbConnection.executeBeforeShutdown("SimpleStorage:remove", async db => {

      if (!(await this.hasKey(tableName, key))) {
        return false;
      }

      await db.execute("DELETE FROM #1 WHERE key = :key".replace("#1", tableName),
        {key}
      );

      return true;
    });
  },

  async hasKey(tableName, key) {
    return (await this.get(tableName, key)) !== null;
  },

  async close() {
    // await this._dbConnection.executeBeforeShutdown("SimpleStorage:remove", async db => {
    if (this._dbConnection) {
      await this._dbConnection.close();
      delete this._dbConnection;
    }
    // });
  },

  async _ensureTable(tableName) {
    await this.openConnection();

    if (!this._dbConnection.tableExists(tableName)) {
      await this._dbConnection.execute(
        "CREATE TABLE #1 (key TEXT PRIMARY KEY, value TEXT)".replace("#1", tableName)
      );
    }
  },
};
