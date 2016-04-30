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

var EXPORTED_SYMBOLS = ['SimpleStorage']

const {classes: Cc, interfaces: Ci, utils: Cu, results : Cr} = Components;

Cu.import("resource://gre/modules/FileUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

let Log;
try {
  XPCOMUtils.importRelative(this, "../log.js");
  Log = setupLogging(logRoot+".SimpleStorage");
  Log.debug("Simple Storage loaded.");
} catch (err) {
  Log = {error: () => {}, debug: () => {}};
}

const KEY_PROFILEDIR = "ProfD";
const FILE_SIMPLE_STORAGE = "simple_storage.sqlite";

const kWorkDone = 42;

/**
 * The global SimpleStorage object. It has various method to instanciate a
 *  storage session with a given style. You should not have two different styles
 *  of API open at the same time on the same table.
 * @namespace
 */
let SimpleStorage = {
  /**
   * Probably the easiest style to use. Function just take a callback (or
   *  continuation) that will be called once the asynchronous storage operation
   *  is done.
   * @param {String} aTblName The table name you wish to use. You can prefix it
   *  with your extension's GUID since it will be shared by all extensions
   *  running on the same profile.
   * @returns {SimpleStorageCps}
   */
  createCpsStyle: function _SimpleStorage_createCps (aTblName) {
    return new SimpleStorageCps(aTblName);
  },

  /**
   * This is another version of the API that offers the appearance of a
   *  synchronous API. Basically, a call to get now returns a function that takes
   *  one argument, that is, the function that it is expected to call to restart
   *  the original computation.
   * You are to use it like this:
   *
   * <pre>
   *  let ss = SimpleStorage.createIteratorStyle("my-tbl");
   *  SimpleStorage.spin(function anon () {
   *    let r = yield ss.get("myKey");
   *    // do stuff with r
   *    yield SimpleStorage.kWorkDone;
   *    // nothing is ever executed after the final yield call
   *  });
   * </pre>
   *
   *  What happens is the anon function is suspended as soon as it yields. If we
   *   call f the function returned by ss.get("myKey"), then spin is the driver
   *   that will run f. Spin passes a function called "finish" to f, and once f
   *   is done fetching the data asynchronously, it calls finish with the result
   *   of its computation.
   *  finish then restarts the anon function with the result of the yield call
   *   being the value f just passed it.
   *
   * @param {String} aTblName
   * @returns {SimpleStorageIterator}
   */
  createIteratorStyle: function _SimpleStorage_createForIterator (aTblName) {
    let cps = new SimpleStorageCps(aTblName);
    return new SimpleStorageIterator(cps);
  },

  /**
   * @TODO
   */
  createPromisesStyle: function _SimpleStorage_createPromisesStyle (aTblName) {
    let cps = new SimpleStorageCps(aTblName);
    return new SimpleStoragePromises(cps);
  },

  kWorkDone: kWorkDone,

  /**
   * The main driver function for the iterator-style API.
   */
  spin: function _SimpleStorage_spin(f) {
    let iterator = f();
    // Note: As a point of interest, calling send(undefined) is equivalent
    // to calling next(). However, starting a newborn generator with any value
    // other than undefined when calling send() will result in a TypeError
    // exception.
    (function send(r) {
      let asyncFunction = iterator.send(r);
      if (asyncFunction !== kWorkDone) {
        asyncFunction(function (r) {
          send(r);
        });
      }
    })();
  },
};

/**
 * You should not instanciate this class directly. Use {@link SimpleStorage.createCpsStyle}.
 * @constructor
 */
function SimpleStorageCps(aTblName) {
  // Will also create the file if it does not exist
  this.dbConnection = Services.storage.openDatabase(FileUtils.getFile(KEY_PROFILEDIR,
                                                                      [FILE_SIMPLE_STORAGE]));
  if (!this.dbConnection.tableExists(aTblName))
    this.dbConnection.executeSimpleSQL(
      "CREATE TABLE #1 (key TEXT PRIMARY KEY, value TEXT)".replace("#1", aTblName)
    );
  this.tableName = aTblName;
}

SimpleStorageCps.prototype = {
  /**
   * Find the data associated to the given key.
   * @param {String} aKey The key used to identify your data.
   * @param {Function} k A function that expects the javascript object you
   *  initially stored, or null.
   */
  get: function _SimpleStorage_get (aKey, k) {
    let statement = this.dbConnection
      .createStatement("SELECT value FROM #1 WHERE key = :key".replace("#1", this.tableName));
    statement.params.key = aKey;
    let results = [];
    statement.executeAsync({
      handleResult: function(aResultSet) {
        for (let row = aResultSet.getNextRow();
             row;
             row = aResultSet.getNextRow()) {
          let value = row.getResultByName("value");
          results.push(value);
        }
      },

      handleError: function(aError) {
        Log.error("Error:", aError.message);
        Log.error("Query was get("+aKey+")");
      },

      handleCompletion: function(aReason) {
        if (aReason != Ci.mozIStorageStatementCallback.REASON_FINISHED) {
          Log.error("Query canceled or aborted!");
          Log.error("Query was get("+aKey+")");
        } else {
          if (results.length > 1) {
            Log.assert(false, "Multiple rows for the same primary key? That's impossible!");
          } else if (results.length == 1) {
            k(JSON.parse(results[0]).value);
          } else if (results.length == 0) {
            k(null);
          }
        }
      }
    });
  },

  /**
   * Store data for the given key. It will erase any previous binding if any,
   *  and you'll lose the data previously associated with that key.
   * @param {String} aKey The key.
   * @param {Object} aVal The value that is to be associated with the key.
   * @param {Function} k A function that expects one argument and will be called
   *  when the data is stored. The argument is true if the row was added, false
   *  if it was just updated.
   */
  set: function _SimpleStorage_set (aKey, aValue, k) {
    this.has(aKey, (function (aResult) {
      let query = aResult
        ? "UPDATE #1 SET value = :value WHERE key = :key"
        : "INSERT INTO #1 (key, value) VALUES (:key, :value)"
      ;
      let statement = this.dbConnection.createStatement(query.replace("#1", this.tableName));
      statement.params.key = aKey;
      statement.params.value = JSON.stringify({ value: aValue });
      statement.executeAsync({
        handleResult: function(aResultSet) {
        },

        handleError: function(aError) {
          Log.error("Error:", aError.message);
          Log.error("Query was get("+aKey+")");
        },

        handleCompletion: function(aReason) {
          if (aReason != Ci.mozIStorageStatementCallback.REASON_FINISHED) {
            Log.error("Query canceled or aborted!");
            Log.error("Query was get("+aKey+")");
          } else {
            k(!aResult);
          }
        }
      });
    }).bind(this));
  },

  /**
   * Check whether there is data associated to the given key.
   * @param {String} aKey The key.
   * @param {Function} k A function that expects a boolean.
   */
  has: function _SimpleStorage_has (aKey, k) {
    this.get(aKey, function (aVal) {
      k(aVal != null);
    });
  },

  /**
   * Remove data associated with the given key.
   * @param {String} aKey The key.
   * @param {Function} k A function that expects a boolean telling whether data
   *  was actually removed or not.
   */
  remove: function _SimpleStorage_remove (aKey, k) {
    this.has(aKey, (function (aResult) {
      if (!aResult) {
        k(false); // element was not removed
      } else {
        let query = "DELETE FROM #1 WHERE key = :key";
        let statement = this.dbConnection.createStatement(query.replace("#1", this.tableName));
        statement.params.key = aKey;
        statement.executeAsync({
          handleResult: function(aResultSet) {
          },

          handleError: function(aError) {
            Log.error("Error:", aError.message);
            Log.error("Query was get("+aKey+")");
          },

          handleCompletion: function(aReason) {
            if (aReason != Ci.mozIStorageStatementCallback.REASON_FINISHED) {
              Log.error("Query canceled or aborted!");
              Log.error("Query was get("+aKey+")");
            } else {
              k(true); // element was removed
            }
          }
        });
      }
    }).bind(this));
  },
}

/**
 * You should not instanciate this class directly. Use {@link SimpleStorage.createIteratorStyle}.
 * @constructor
 */
function SimpleStorageIterator(aSimpleStorage) {
  this.ss = aSimpleStorage;
}

SimpleStorageIterator.prototype = {

  get: function _SimpleStorage_get (aKey) (function (finish) {
    this.get(aKey, function (result) finish(result));
  }).bind(this.ss),

  set: function _SimpleStorage_set (aKey, aValue) (function (finish) {
    this.set(aKey, aValue, function (result) finish(result));
  }).bind(this.ss),

  has: function _SimpleStorage_has (aKey) (function (finish) {
    this.has(aKey, function (result) finish(result));
  }).bind(this.ss),

  remove: function _SimpleStorage_remove (aKey) (function (finish) {
    this.remove(aKey, function (result) finish(result));
  }).bind(this.ss),

}
