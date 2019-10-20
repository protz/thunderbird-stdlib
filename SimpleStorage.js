/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @fileoverview This file exports the SimpleStorage wrapper around mozStorage.
 *  It is designed to help you use mozStorage is a simple get/set/has/remove
 *  API.
 * @author Jonathan Protzenko
 */

var EXPORTED_SYMBOLS = ["SimpleStorage"];

const { Sqlite } = ChromeUtils.import("resource://gre/modules/Sqlite.jsm");
const { OS } = ChromeUtils.import("resource://gre/modules/osfile.jsm");

let Log;
try {
  const { logRoot, setupLogging } = ChromeUtils.import(
    new URL("../log.js", this.__URI__)
  );
  Log = setupLogging(logRoot + ".SimpleStorage");
  Log.debug("Simple Storage loaded.");
} catch (err) {
  Log = { error: () => {}, debug: () => {} };
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
      { key }
    );

    if (rows.length > 1) {
      Log.assert(
        false,
        "Multiple rows for the same primary key? That's impossible!"
      );
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

    await this._dbConnection.executeBeforeShutdown(
      "SimpleStorage:set",
      async db => {
        let query = (await this.hasKey(tableName, key))
          ? "UPDATE #1 SET value = :value WHERE key = :key"
          : "INSERT INTO #1 (key, value) VALUES (:key, :value)";

        await db.execute(query.replace("#1", tableName), {
          key,
          value: JSON.stringify({ value }),
        });
      }
    );
  },

  async remove(tableName, key) {
    if (!this._dbConnection) {
      await this._ensureTable(tableName);
    }

    await this._dbConnection.executeBeforeShutdown(
      "SimpleStorage:remove",
      async db => {
        if (!(await this.hasKey(tableName, key))) {
          return false;
        }

        await db.execute(
          "DELETE FROM #1 WHERE key = :key".replace("#1", tableName),
          { key }
        );

        return true;
      }
    );
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
        "CREATE TABLE #1 (key TEXT PRIMARY KEY, value TEXT)".replace(
          "#1",
          tableName
        )
      );
    }
  },
};
