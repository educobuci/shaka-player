/**
 * Copyright 2014 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * @fileoverview Manages a SourceBuffer an provides an enhanced interface
 * based on Promises.
 */

goog.provide('shaka.media.SourceBufferManager');

goog.require('shaka.asserts');
goog.require('shaka.media.SegmentRange');
goog.require('shaka.util.EventManager');
goog.require('shaka.util.IBandwidthEstimator');
goog.require('shaka.util.PublicPromise');
goog.require('shaka.util.RangeRequest');
goog.require('shaka.util.Task');



/**
 * Creates a SourceBufferManager (SBM).
 *
 * The SBM manages access to a SourceBuffer object through a fetch operation
 * and a clear operation. It also maintains a "virtual source buffer" to keep
 * track of which segments have been appended to the actual underlying source
 * buffer. The SBM uses this virtual source buffer because it cannot rely on
 * the browser to tell it what is in the underlying SourceBuffer because the
 * segment index may use PTS (presentation timestamps) and the browser may use
 * DTS (decoding timestamps) or vice-versa.
 *
 * @param {!MediaSource} mediaSource The SourceBuffer's parent MediaSource.
 * @param {!SourceBuffer} sourceBuffer
 * @param {!shaka.util.IBandwidthEstimator} estimator A bandwidth estimator to
 *     attach to all requests.
 * @struct
 * @constructor
 */
shaka.media.SourceBufferManager = function(
    mediaSource, sourceBuffer, estimator) {
  /** @private {!MediaSource} */
  this.mediaSource_ = mediaSource;

  /** @private {!SourceBuffer} */
  this.sourceBuffer_ = sourceBuffer;

  /** @private {!shaka.util.IBandwidthEstimator} */
  this.estimator_ = estimator;

  /** @private {!shaka.util.EventManager} */
  this.eventManager_ = new shaka.util.EventManager();

  /**
   * A map that indicates which segments from the current stream have been
   * inserted into the SourceBuffer. These segments may or may not have been
   * evicted by the browser.
   * @private {!Object.<number, boolean>}
   */
  this.inserted_ = {};

  /** @private {shaka.util.Task} */
  this.task_ = null;

  /** @private {shaka.util.PublicPromise} */
  this.operationPromise_ = null;

  this.eventManager_.listen(
      this.sourceBuffer_,
      'updateend',
      this.onSourceBufferUpdateEnd_.bind(this));
};


/**
 * A fudge factor to apply to buffered ranges to account for rounding error.
 * @const {number}
 * @private
 */
shaka.media.SourceBufferManager.FUDGE_FACTOR_ = 1 / 60;


/**
 * Destroys the SourceBufferManager.
 * @suppress {checkTypes} to set otherwise non-nullable types to null.
 */
shaka.media.SourceBufferManager.prototype.destroy = function() {
  this.abort();

  this.operationPromise_ = null;
  this.task_ = null;

  this.inserted_ = null;

  this.eventManager_.destroy();
  this.eventManager_ = null;

  this.sourceBuffer_ = null;
  this.mediaSource_ = null;
};


/**
 * Checks if the segment corresponding to the given SegmentReference has
 * been inserted.
 * @param {!shaka.media.SegmentReference} reference
 * @return {boolean} True if the segment has been inserted.
 */
shaka.media.SourceBufferManager.prototype.isInserted = function(reference) {
  return this.inserted_[reference.id];
};


/**
 * Checks if the given timestamp is buffered according to the SourceBuffer.
 * @param {number} timestamp
 * @return {boolean} True if the timestamp is buffered.
 */
shaka.media.SourceBufferManager.prototype.isBuffered = function(timestamp) {
  return this.bufferedAheadOf(timestamp) > 0;
};


/**
 * Computes how far ahead of the given timestamp we have buffered.
 * @param {number} timestamp
 * @return {number} in seconds
 */
shaka.media.SourceBufferManager.prototype.bufferedAheadOf =
    function(timestamp) {
  var b = this.sourceBuffer_.buffered;
  for (var i = 0; i < b.length; ++i) {
    var start = b.start(i) - shaka.media.SourceBufferManager.FUDGE_FACTOR_;
    var end = b.end(i) + shaka.media.SourceBufferManager.FUDGE_FACTOR_;
    if (timestamp >= start && timestamp <= end) {
      return b.end(i) - timestamp;
    }
  }
  return 0;
};


/**
 * Fetches the segments specified by the given SegmentRange and appends the
 * retrieved segment data to the underlying SourceBuffer. This cannot be called
 * if another operation is in progress.
 *
 * @param {!shaka.media.SegmentRange} segmentRange
 * @param {ArrayBuffer} initSegment Optional initialization segment that
 *     will be appended to the underlying SourceBuffer before the retrieved
 *     segment data.
 * @param {!Array.<number>} endEarlyOn A list of statuses on which the task
 *     will be ended early without failure.
 *
 * @return {!Promise}
 */
shaka.media.SourceBufferManager.prototype.fetch = function(
    segmentRange, initSegment, endEarlyOn, streamInfo) {
  shaka.log.v1('fetch');
  
  this.streamInfo = streamInfo;

  // Check state.
  shaka.asserts.assert(!this.task_);
  if (this.task_) {
    var error = new Error('Cannot fetch: previous operation not complete.');
    error.type = 'stream';
    return Promise.reject(error);
  }

  this.task_ = new shaka.util.Task();

  if (initSegment) {
    this.task_.append(function() {
      var p = this.append_(initSegment);
      return [p, this.abort_.bind(this)];
    }.bind(this));
  }

  // If the segments are all located at the same URL then only a single request
  // is required.
  var singleLocation = true;
  var references = segmentRange.references;

  if (references.length) {
    var firstUrl = references[0].url.toString();
    for (var i = 1; i < references.length; ++i) {
      if (references[i].url.toString() != firstUrl) {
        singleLocation = false;
        break;
      }
    }

    if (singleLocation) {
      this.appendFetchStages_(references, endEarlyOn);
    } else {
      for (var i = 0; i < references.length; ++i) {
        this.appendFetchStages_([references[i]], endEarlyOn);
      }
    }
  }

  return this.startTask_();
};


/**
 * Resets the virtual source buffer and clears all media from the underlying
 * SourceBuffer. The returned promise will resolve immediately if there is no
 * media within the underlying SourceBuffer. This cannot be called if another
 * operation is in progress.
 *
 * @return {!Promise}
 */
shaka.media.SourceBufferManager.prototype.clear = function() {
  shaka.log.v1('clear');

  // Check state.
  shaka.asserts.assert(!this.task_);
  if (this.task_) {
    var error = new Error('Cannot clear: previous operation not complete.');
    error.type = 'stream';
    return Promise.reject(error);
  }

  this.task_ = new shaka.util.Task();
  this.task_.append(function() {
    var p = this.clear_();
    return [p, this.abort_.bind(this)];
  }.bind(this));

  return this.startTask_();
};


/**
 * Resets the map of inserted segments without removing any media from the
 * underlying SourceBuffer.  This should be called when switching
 * representations.
 */
shaka.media.SourceBufferManager.prototype.reset = function() {
  this.inserted_ = {};
};


/**
 * Aborts the current operation if one exists.
 * The returned promise will never be rejected.
 *
 * @return {!Promise}
 */
shaka.media.SourceBufferManager.prototype.abort = function() {
  shaka.log.v1('abort');
  if (!this.task_) {
    return Promise.resolve();
  }
  return this.task_.abort();
};


/**
 * Adds stages to the task to fetch references, append them to the source
 * buffer, and update the virtual source buffer.
 *
 * All references must have the same URL.  Only one fetch will be made.
 *
 * @param {!Array.<!shaka.media.SegmentReference>} references
 * @param {!Array.<number>} endEarlyOn A list of statuses on which the task
 *     will be ended early without failure.
 * @private
 */
shaka.media.SourceBufferManager.prototype.appendFetchStages_ =
    function(references, endEarlyOn) {
  shaka.log.v1('appendFetchStages_');

  shaka.asserts.assert(this.task_);
  shaka.asserts.assert(references.every(function(item) {
    return item.url == references[0].url;
  }));

  this.task_.append(
      function() {
        var refDuration = references[0].endTime ?
            (references[0].endTime - references[0].startTime) : 1;
        var request = new shaka.util.RangeRequest(
            references[0].url.toString(),
            references[0].startByte,
            references[references.length - 1].endByte,
            3 /* maxAttempts */,
            refDuration * 1000 /* baseRetryDelayMs */);
        request.estimator = this.estimator_;

        var p = request.send().catch(function(error) {
          if (endEarlyOn.indexOf(error.status) != -1) {
            // End the task early, but do not fail the task.
            this.task_.end();
          } else {
            // Actual error.  Pass it along.
            return Promise.reject(error);
          }
        }.bind(this));

        return [p, request.abort.bind(request)];
      }.bind(this));
  this.task_.append(
      /** @param {!ArrayBuffer} data */
      function(data) {
        shaka.log.debug('Estimated bandwidth:', (this.estimator_.getBandwidth() / 1e6).toFixed(2), 'Mbps');
        if (shaka.dash.mss.baseUrl) {
          var controller = new uux.MssFragmentController();
          data = controller.convertFragment(new Uint8Array(data), references[0], this.streamInfo);
          //data = uux.convertFragment(new Uint8Array(data), null, false);
        }
        var p = this.append_(data);
        return [p, this.abort_.bind(this)];
      }.bind(this));
  this.task_.append(
      function() {
        for (var i = 0; i < references.length; ++i) {
          this.inserted_[references[i].id] = true;
        }
      }.bind(this));
};


/**
 * Starts the task and returns a Promise which is resolved/rejected after the
 * task ends and is cleaned up.
 * @return {!Promise}
 * @private
 */
shaka.media.SourceBufferManager.prototype.startTask_ = function() {
  shaka.asserts.assert(this.task_);
  this.task_.start();
  return this.task_.getPromise().then(function() {
    this.task_ = null;
  }.bind(this)).catch(function(error) {
    this.task_ = null;
    return Promise.reject(error);
  }.bind(this));
};


/**
 * Append to the source buffer.
 * @param {!ArrayBuffer} data
 * @return {!Promise}
 * @private
 */
shaka.media.SourceBufferManager.prototype.append_ = function(data) {
  shaka.asserts.assert(!this.operationPromise_);
  shaka.asserts.assert(this.task_);

  try {    
    // if (shaka.dash.mss.baseUrl) {
    //   //var controller = new uux.MssFragmentController();
    //   //var converted = controller.convertFragment(new Uint8Array(data, this.streamInfo));
    //   var converted = uux.convertFragment(new Uint8Array(data), null, false);
    //
    //   // This will trigger an 'updateend' event.
    //   this.sourceBuffer_.appendBuffer(converted);
    // }
    // else
    // {
      // This will trigger an 'updateend' event.
    this.sourceBuffer_.appendBuffer(data); 
    // }
  } catch (exception) {
    shaka.log.debug('Failed to append buffer:', exception);
    return Promise.reject(exception);
  }

  this.operationPromise_ = new shaka.util.PublicPromise();
  return this.operationPromise_;
};


/**
 * Clear the source buffer.
 * @return {!Promise}
 * @private
 */
shaka.media.SourceBufferManager.prototype.clear_ = function() {
  shaka.asserts.assert(!this.operationPromise_);

  if (this.sourceBuffer_.buffered.length == 0) {
    shaka.log.v1('Nothing to clear.');
    shaka.asserts.assert(Object.keys(this.inserted_).length == 0);
    return Promise.resolve();
  }

  try {
    // This will trigger an 'updateend' event.
    this.sourceBuffer_.remove(0, Number.POSITIVE_INFINITY);
  } catch (exception) {
    shaka.log.debug('Failed to clear buffer:', exception);
    return Promise.reject(exception);
  }

  // Clear |inserted_| immediately since any inserted segments will be
  // gone soon.
  this.inserted_ = {};

  this.operationPromise_ = new shaka.util.PublicPromise();
  return this.operationPromise_;
};


/**
 * Abort the current operation on the source buffer.
 * @private
 */
shaka.media.SourceBufferManager.prototype.abort_ = function() {
  shaka.asserts.assert(this.operationPromise_);
  if (this.mediaSource_.readyState == 'open') {
    this.sourceBuffer_.abort();
  }
};


/**
 * |sourceBuffer_|'s 'updateend' callback.
 *
 * @param {!Event} event
 * @private
 */
shaka.media.SourceBufferManager.prototype.onSourceBufferUpdateEnd_ =
    function(event) {
  shaka.log.v1('onSourceBufferUpdateEnd_');

  shaka.asserts.assert(!this.sourceBuffer_.updating);
  shaka.asserts.assert(this.operationPromise_);

  this.operationPromise_.resolve();
  this.operationPromise_ = null;
};

uux.times=[0,
20020000,
40040000,
60060000,
80080000,
100100000,
120120000,
140140000,
160160000,
180180000,
200200000,
220220000,
240240000,
260260000,
280280000,
300300000,
320320000,
340340000,
360360000,
383049333];

uux.currentTime = -1;

uux.convertFragment = function (buffer, chunkTime, isEncrypted) {
  chunkTime = uux.times[uux.currentTime++];

    // This assumes the structure is only moof -> mfhd/traf and mdat, might not be valid for all cases
    var mfhd = uux.getBox(buffer, "mfhd");
    var traf = uux.getBox(buffer, "traf");
    var mdat = uux.getBox(buffer, "mdat");
    
    if (!mfhd) {
      return buffer;
    }
    
    var ivDataLength = 0;
    if (!isEncrypted) {
        // Appends tfdt box
        var tfdt = uux.createTfdtBox(chunkTime);
        uux.appendToArray(traf, tfdt);
        uux.updateBoxSize(traf);
    }
    else {
        // Reads the traf boxes
        var tfhd = uux.getBox(buffer, "tfhd");
        var trun = uux.getBox(buffer, "trun");
        var sdtp = uux.getBox(buffer, "sdtp");
        var uuid = uux.getBox(buffer, "uuid");
        
        var ivCount = uux.byteArrayToInt(trun, 12);
        var saiz = uux.createSaizBox(ivCount);
        var saio = uux.createSaioBox();

        // Creates the tfdt box
        var tfdt = uux.createTfdtBox(chunkTime);

        // Reassembles traf box without uuid
        traf = [];
        uux.appendToArray(traf, uux.intToByteArray(0));                    // size = 0/placeholder, FIELD_UINT32
        uux.appendToArray(traf, uux.stringToByteArray("traf"));            // boxtype, FIELD_ID
        uux.appendToArray(traf, tfhd);
        uux.appendToArray(traf, trun);
        uux.appendToArray(traf, saiz);
        uux.appendToArray(traf, saio);
        uux.appendToArray(traf, tfdt);
        
        // Reads the IV data from the uuid box
        var ivData = uux.getArraySegment(uuid, 32, uuid.length);
        
        // SENC Block
        var senc = [];
        uux.appendToArray(senc, uux.intToByteArray(0));                    // size = 0/placeholder, FIELD_UINT32
        uux.appendToArray(senc, uux.stringToByteArray("senc"));            // boxtype, FIELD_ID
        uux.appendToArray(senc, uux.intToByteArray(2));
        uux.appendToArray(senc, uux.intToByteArray(ivCount));
        uux.appendToArray(senc, ivData);
        uux.updateBoxSize(senc);
        
        uux.appendToArray(traf, senc);

        uux.updateBoxSize(traf);

        // Reads the media data from the mdat box
        var mediaData = uux.getArraySegment(mdat, 8, mdat.length);

        // Reassembles mdat box including the IV data
        mdat = [];
        uux.appendToArray(mdat, uux.intToByteArray(0));                    // size = 0/placeholder, FIELD_UINT32
        uux.appendToArray(mdat, uux.stringToByteArray("mdat"));            // boxtype, FIELD_ID
        //uux.appendToArray(mdat, ivData);
        uux.appendToArray(mdat, mediaData);
        uux.updateBoxSize(mdat);

        ivDataLength = ivData.length;
        
        // Changes tfhd flags to 0x20000
        var tfhdPosition = uux.findBox(traf, "tfhd");
        traf[tfhdPosition + 9] = 0x02;
    }

    // Result data
    var result = [];
    
    // Reassembles moof box
    var moof = [];
    uux.appendToArray(moof, uux.intToByteArray(0));                    // size = 0/placeholder, FIELD_UINT32
    uux.appendToArray(moof, uux.stringToByteArray("moof"));            // boxtype, FIELD_ID
    uux.appendToArray(moof, mfhd);
    uux.appendToArray(moof, traf);
    uux.updateBoxSize(moof);
    
    uux.appendToArray(result, moof);
    
    uux.appendToArray(result, mdat);

    // Corrects the data offset in the trun and saio boxes
    var mdatPosition = uux.findBox(result, "mdat");

    var moofPosition = uux.findBox(result, "moof");
    var trunPosition = uux.findBox(result, "trun");
    uux.updateInArray(result, uux.intToByteArray(mdatPosition + 8 - moofPosition), trunPosition + 16);

    if (isEncrypted) {
        var sencPosition = uux.findBox(result, "senc");
        var saioPosition = uux.findBox(result, "saio");
        uux.updateInArray(result, uux.intToByteArray(sencPosition - moofPosition + 16), saioPosition + 16);
    }
    
    var resultArray = new Uint8Array(result);
    
    //if (uux.currentTime == 0) uux.download("chunk_" + uux.currentTime + "_" + new Date().getTime() + ".bin", resultArray);

    return resultArray;
}

uux.createTfdtBox = function (chunkTime) {
    var buffer = [];

    uux.appendToArray(buffer, uux.intToByteArray(0));          // size = 0/placeholder, FIELD_UINT32
    uux.appendToArray(buffer, uux.stringToByteArray("tfdt"));  // boxtype, FIELD_ID
    uux.appendToArray(buffer, [1]);                            // version = 0, FIELD_INT8
    uux.appendToArray(buffer, [0, 0, 0]);                      // flags = 0, FIELD_BIT24

    uux.appendToArray(buffer, uux.longToByteArray(chunkTime)); // baseMediaDecodeTime, FIELD_UINT64

    uux.updateBoxSize(buffer);
    return (buffer);
}

uux.createSaizBox = function (ivCount) {
    var buffer = [];

    uux.appendToArray(buffer, uux.intToByteArray(0));                    // size = 0/placeholder, FIELD_UINT32
    uux.appendToArray(buffer, uux.stringToByteArray("saiz"));            // boxtype, FIELD_ID

    uux.appendToArray(buffer, [0x0]);                                    // version
    uux.appendToArray(buffer, uux.intToByteArray(16));                   // sample size
    uux.appendToArray(buffer, uux.intToByteArray(ivCount));              // iv count

    uux.updateBoxSize(buffer);
    return (buffer);
}

uux.createSaioBox = function () {
    var buffer = [];

    uux.appendToArray(buffer, uux.intToByteArray(0));                    // size = 0/placeholder, FIELD_UINT32
    uux.appendToArray(buffer, uux.stringToByteArray("saio"));            // boxtype, FIELD_ID

    uux.appendToArray(buffer, uux.intToByteArray(0));                    // version?
    uux.appendToArray(buffer, uux.intToByteArray(1));                    // flags?
    uux.appendToArray(buffer, uux.intToByteArray(0));                    // iv address = 0/placeholder

    uux.updateBoxSize(buffer);
    return (buffer);
}


uux.appendToArray = function (buffer, data) {
    for (var i = 0; i < data.length; i++) buffer.push(data[i]);
}

uux.updateInArray = function (buffer, data, position) {
    for (var i = 0; i < data.length; i++) buffer[position + i] = data[i];
}

uux.getArraySegment = function (buffer, start, end) {
    var result = [];
    for (var i = 0; i < (end - start) ; i++) result.push(buffer[start + i]);
    return (result);
}

uux.shortToByteArray = function (shortValue) {
    return uux.numberToByteArray(shortValue, [0, 0]);
}

uux.intToByteArray = function (intValue) {
    return uux.numberToByteArray(intValue, [0, 0, 0, 0]);
}

uux.longToByteArray = function (longValue) {
    return uux.numberToByteArray(longValue, [0, 0, 0, 0, 0, 0, 0, 0]);
}

uux.stringToByteArray = function (stringValue) {
    var buffer = [];
    for (var i = 0, len = stringValue.length; i < len; i++) {
        buffer.push(stringValue.charCodeAt(i));
    }
    return (buffer);
}

uux.zeroTerminatedStringToByteArray = function (stringValue) {
    var buffer = [];
    for (var i = 0, len = stringValue.length; i < len; i++) {
        buffer.push(stringValue.charCodeAt(i));
    }
    buffer.push(0);
    return (buffer);
}

uux.shortArrayToByteArray = function (shortArrayValue) {

    var result = [];
    for (var i = 0; i < shortArrayValue.length; i++) {
        result = result.concat(uux.shortToByteArray(shortArrayValue[i]));
    }
    return result;
}

uux.intArrayToByteArray = function (intArrayValue) {

    var result = [];
    for (var i = 0; i < intArrayValue.length; i++) {
        result = result.concat(uux.intToByteArray(intArrayValue[i]));
    }
    return result;
}

uux.numberToByteArray = function (numberValue, buffer) {
    for (var i = 0; i < buffer.length; i++) {
        var byte = numberValue & 0xff;
        buffer[i] = byte;
        numberValue = (numberValue - byte) / 256;
    }
    return buffer.reverse();
}

uux.byteArrayToInt = function (buffer, position) {
    var value = 0;
    for (var i = 0; i < 4; i++) {
        value = (value * 256) + buffer[position + i];
    }
    return value;
}

// Copied from hasplayer -> Mp4Processor.js
uux.stringToCharCode = function (str) {

    var code = 0;
    for (var i = 0; i < str.length; i++) {
        code |= str.charCodeAt(i) << ((str.length - i - 1) * 8);
    }
    return code;
}

// Copied from hasplayer -> Mp4Processor.js
uux.getLanguageCode = function (language) {
    var result = 0;

    var firstLetterCode = (language.charCodeAt(0) - 96) << 10;
    var secondLetterCode = (language.charCodeAt(1) - 96) << 5;
    var thirdLetterCode = language.charCodeAt(2) - 96;

    result = firstLetterCode | secondLetterCode | thirdLetterCode;

    return result;
},

uux.findBox = function (buffer, boxType) {
    var boxTypeData = uux.stringToByteArray(boxType);
    for (var i = 0; i < buffer.length - 8; i++) {
        if (buffer[i + 4] == boxTypeData[0] &&
            buffer[i + 5] == boxTypeData[1] &&
            buffer[i + 6] == boxTypeData[2] &&
            buffer[i + 7] == boxTypeData[3])
            return (i);
    }
    return (-1);
}

uux.getBox = function (buffer, boxType) {
    var boxLocation = uux.findBox(buffer, boxType);
    if (boxLocation == -1) return null;

    var size = uux.byteArrayToInt(buffer, boxLocation);
    var box = uux.getArraySegment(buffer, boxLocation, boxLocation + size);

    return (box);
}

uux.updateBoxSize = function (buffer) {
    var sizeBuffer = uux.intToByteArray(buffer.length);
    buffer[0] = sizeBuffer[0];
    buffer[1] = sizeBuffer[1];
    buffer[2] = sizeBuffer[2];
    buffer[3] = sizeBuffer[3];
}

uux.byteArrayToAsciOnlyString = function(byteArray)
{
  var asciString = "";
  for (var i = 0; i < byteArray.length; i++) {
    var byte = byteArray[i];
    if (byte >= 32 && byte <= 126) {
      asciString += String.fromCharCode(byte);
    }
  }
  return asciString;
}

window.requestFileSystem = window.requestFileSystem || window.webkitRequestFileSystem;
uux.download = function (fileName, byteArray) {
    window.requestFileSystem(window.TEMPORARY, byteArray.length, function (fs) {
        fs.root.getFile(fileName, { create: true }, function (fileEntry) { 
            fileEntry.createWriter(function (fileWriter) {

                var blob = new Blob([byteArray]);
                fileWriter.addEventListener("writeend", function () {
                    location.href = fileEntry.toURL();
                }, false);
                fileWriter.write(blob);
            }, function () { });
        }, function () { });
    }, function () { });
}