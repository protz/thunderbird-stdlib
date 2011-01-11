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

var EXPORTED_SYMBOLS = ['SimpleStorage']

const Ci = Components.interfaces;
const Cc = Components.classes;
const Cu = Components.utils;
const Cr = Components.results;

Cu.import("resource://conversations/log.js");
let Log = setupLogging("Conversations.SimpleStorage");
Log.debug("Simple Storage loaded.");

let gStorageService = Cc["@mozilla.org/storage/service;1"]  
                      .getService(Ci.mozIStorageService);  
let gDbFile = Cc["@mozilla.org/file/directory_service;1"]  
              .getService(Ci.nsIProperties)  
              .get("ProfD", Ci.nsIFile);  
gDbFile.append("simple_storage.sqlite");  

const kWorkDone = 42;

let SimpleStorage = {
  createCpsStyle: function _SimpleStorage_createCps (aTblName) {
    return new SimpleStorageCps(aTblName);
  },

  createIteratorStyle: function _SimpleStorage_createForIterator (aTblName) {
    let cps = new SimpleStorageCps(aTblName);
    return new SimpleStorageIterator(cps);
  },

  createPromisesStyle: function _SimpleStorage_createPromisesStyle (aTblName) {
    let cps = new SimpleStorageCps(aTblName);
    return new SimpleStoragePromises(cps);
  },

  kWorkDone: kWorkDone,

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
 * Open a new storage instance.
 * @param {String} aTblName A unique identifier that tells who you are. Other
 *  clients of SimpleStorage will also provide their own identifier. You can use
 *  the GUID of your extension, for instance.
 * @return A new SimpleStorage instance.
 */
function SimpleStorageCps(aTblName) {
  // Will also create the file if it does not exist  
  this.dbConnection = gStorageService.openDatabase(gDbFile);
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
 * This is another version of the API that offers the appearance of a
 *  synchronous API. Basically, a call to get now returns a function that takes
 *  one argument, that is, the function that it is expected to call to restart
 *  the original computation.
 * You are to use it like this:
 *
 *  SimpleStorage.spin(function anon () {
 *    let r = yield get("myKey");
 *    // do stuff with r
 *  });
 *
 *  What happens is the anon function is suspended as soon as it yields. If we
 *   call f the function returned by get("myKey"), then spin is the driver that
 *   will run f, and is expected to call the argument it's passed one it's done.
 *   That argument is a function that takes the result that is to be returned
 *   when it restarts the anon function (the value that ends up being r).
 *  This is exactly what our little wrappers below do.
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
