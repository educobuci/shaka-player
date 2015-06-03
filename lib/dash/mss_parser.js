goog.provide('shaka.dash.mss');

goog.require('goog.Uri');
goog.require('shaka.log');
goog.require('shaka.util.DataViewReader');
goog.require('shaka.util.LanguageUtils');
goog.require('shaka.util.Pssh');
goog.require('shaka.util.Uint8ArrayUtils');
MIN_BUFFER_TIME = 10;

shaka.dash.mss.baseUrl = null;

shaka.dash.mss.parseMss = function(source, url) {
  var mss = shaka.dash.mss;
  mss.baseUrl = new goog.Uri(url);
  
  var parser = new DOMParser();
  var manifest = parser.parseFromString(source, 'text/xml');

  if (!manifest) {
    shaka.log.error('Failed to parse MSS XML.');
    return null;
  }
  
  var smoothStreamingMedia = uux.xml.findChild(manifest, 'SmoothStreamingMedia');
  var timeScale = uux.xml.parseInt(smoothStreamingMedia, 'TimeScale');
  var duration = uux.xml.parseInt(smoothStreamingMedia, 'Duration') / timeScale;
  
  var mpd = {
    availabilityStartTime: null,
    baseUrl: shaka.dash.mss.baseUrl,
    id: null,
    mediaPresentationDuration: duration,
    minBufferTime: MIN_BUFFER_TIME,
    minUpdatePeriod: null,
    periods: [],
    suggestedPresentationDelay: 1,
    timeShiftBufferDepth: null,
    type: 'static'
  }
  
  var period = {
    adaptationSets: [],
    baseUrl: shaka.dash.mss.baseUrl,
    duration: duration,
    id: null,
    segmentBase: null,
    segmentList: null,
    segmentTemplate: null,
    start: 0
  };
    
  var streamElements = uux.xml.findChildren(smoothStreamingMedia, "StreamIndex");
  
  for (var i = 0; i < streamElements.length; i++) {
    var streamElement = streamElements[i];
    var qualityLevels = uux.xml.findChildren(streamElement, "QualityLevel");
    
    // User the last quality level to build the adaptation set
    var adaptationSet = mss.parseStreamQuality(streamElement, qualityLevels[qualityLevels.length -1]);
    adaptationSet.representations = [];
    
    for (var j = 0; j < qualityLevels.length; j++) {
      var level = qualityLevels[j];
      var representation = mss.parseStreamQuality(streamElement, level);
      representation.bandwidth = uux.xml.parseInt(level, "Bitrate");
      representation.id = streamElement.getAttribute("Name") + "=" + representation.bandwidth; // e.g video=1500000
      adaptationSet.representations.push(representation);
    }
    
    period.adaptationSets.push(adaptationSet);
  }
  
  mpd.periods = [period];
  
  return mpd;
};

shaka.dash.mss.parseStreamQuality = function(streamElement, qualityLevel) {
  var mss = shaka.dash.mss;
  var fourCC = qualityLevel.getAttribute('FourCC');
  var codecs = "0x00000000";
  var contentType, height, id, lang, main, mimeType, representations, segmentBase, segmentList, segmentTemplate, width;
  
  if (fourCC) {
    if (fourCC === "H264" || fourCC === "AVC1") {
      codecs = mss.getH264Codec(qualityLevel);
    } else if (fourCC.indexOf("AAC") >= 0){
      codecs = mss.getAACCodec(qualityLevel);
    }
  }
  
  contentType = streamElement.getAttribute('Type');
  
  if (contentType === "video") {
    height = uux.xml.parseInt(qualityLevel, "MaxHeight");
    width = uux.xml.parseInt(qualityLevel, "MaxWidth");
  }
  
  var mimeTypeMap = {
      "video" : "video/mp4",
      "audio" : "audio/mp4",
      "text"  : "application/ttml+xml+mp4"
  };
  
  mimeType = mimeTypeMap[contentType];
  
  lang = streamElement.getAttribute('Language');
  
  segmentTemplate = {
    indexUrlTemplate: null,
    initializationUrlTemplate: null,
    mediaUrlTemplate: "QualityLevels($Bandwidth$)/Fragments(" + contentType + "=$Time$)",
    presentationTimeOffset: null,
    segmentDuration: 0,
    startNumber: 1,
    timeline: { timePoints: [] },
    timescale: uux.xml.parseInt(streamElement, 'TimeScale')
  }
  
  var timelineElements = uux.xml.findChildren(streamElement, "c");

  for (var j = 0; j < timelineElements.length; j++) {
    var element = timelineElements[j];
    var duration = uux.xml.parseInt(element, "d");
    var repeat = 0;
    var startTime = uux.xml.parseInt(element, "t");
    var k = j;
    while ((k = (j + 1)) < timelineElements.length
            &&  (nextDuration = uux.xml.parseInt(timelineElements[k], "d")) === duration) {
      j++;
      repeat++;
    }
    var entry = { duration: duration, repeat: repeat > 0 ? repeat : null, startTime: startTime };
    segmentTemplate.timeline.timePoints.push(entry);
  }
  
  return {
    bandwidth: null,
    baseUrl: shaka.dash.mss.baseUrl,
    codecs: codecs,
    contentProtections: [],
    contentType: contentType,
    height: height,
    id: null,
    lang: lang,
    main: main,
    mimeType: mimeType,
    segmentBase: segmentBase,
    segmentList: segmentList,
    segmentTemplate: segmentTemplate,
    width: width
  };
}

shaka.dash.mss.getH264Codec = function (qualityLevel) {
  var codecPrivateData = qualityLevel.getAttribute('CodecPrivateData');
  var nalHeader;
  var avcoti;


  // Extract from the CodecPrivateData field the hexadecimal representation of the following
  // three bytes in the sequence parameter set NAL unit.
  // => Find the SPS nal header
  nalHeader = /00000001[0-9]7/.exec(codecPrivateData);
  // => Find the 6 characters after the SPS nalHeader (if it exists)
  avcoti = nalHeader && nalHeader[0] ? (codecPrivateData.substr(codecPrivateData.indexOf(nalHeader[0])+10, 6)) : undefined;

  return "avc1." + avcoti;
};

shaka.dash.mss.getAACCodec = function (qualityLevel) {
    var objectType = 0,
        codecPrivateData = qualityLevel.getAttribute('CodecPrivateData'),
        codecPrivateDataHex,
        arr16;

    //chrome problem, in implicit AAC HE definition, so when AACH is detected in FourCC
    //set objectType to 5 => strange, it should be 2
    if (qualityLevel.getAttribute('FourCC') === "AACH") {
        objectType = 0x05;
    }
    if (objectType === 0)
        objectType = (parseInt(codecPrivateData.substr(0, 2), 16) & 0xF8) >> 3;
    
    return "mp4a.40." + objectType;
};


var uux = uux || {};
uux.xml = {
  findChild: function(elem, name) {
    var childElement = null;

    for (var i = 0; i < elem.childNodes.length; i++) {
      if (elem.childNodes[i].tagName != name) {
        continue;
      }
      childElement = elem.childNodes[i];
      break;
    }

    return childElement;
  },
  findChildren: function(elem, name) {
    var children = [];

    for (var i = 0; i < elem.childNodes.length; i++) {
      var childElement = elem.childNodes[i]
      if (elem.childNodes[i].tagName != name) {
        continue;
      }
      children.push(childElement);
    }

    return children;
  },
  parseInt: function(elem, name)
  {
    var value = elem.getAttribute(name);
    if (value) {
      return parseInt(value, 10);
    }
    return null;
  }
};