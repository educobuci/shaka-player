var MIN_BUFFER_TIME = 10;
var DEFAULT_TIMESCALE = 10000000;

shaka.dash.mss = shaka.dash.mss || {};
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
  var timeScale = uux.xml.parseInt(smoothStreamingMedia, 'TimeScale') || DEFAULT_TIMESCALE;
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
  var repId = 0;
  
  for (var i = 0; i < streamElements.length; i++) {
    var streamElement = streamElements[i];
    var qualityLevels = uux.xml.findChildren(streamElement, "QualityLevel");
    
    // Use the last quality level to build the adaptation set
    var adaptationSet = mss.parseStreamQuality(streamElement, qualityLevels[qualityLevels.length -1]);
    adaptationSet.representations = [];
    adaptationSet.id = (i).toString();
    
    if(adaptationSet.contentType === "text") continue;
    
    for (var j = 0; j < qualityLevels.length; j++) {
      var level = qualityLevels[j];
      var representation = mss.parseStreamQuality(streamElement, level);
      var protection = uux.xml.findChild(smoothStreamingMedia, "Protection");
      var protectionHeader = shaka.util.Uint8ArrayUtils.fromBase64(protection.firstChild.textContent);
      var headerXml = uux.byteArrayToAsciiOnlyString(protectionHeader).substring(2); // ignore the first 2 chars
      var headerDocument = (new DOMParser()).parseFromString(headerXml, "text/xml");
      var prKID = uux.xml.findChild(headerDocument.firstChild.firstChild, "KID").textContent;
      
      // Complement the fields that can't be parsed only from SteamIndex or QualityLevel
      representation.bandwidth = uux.xml.parseInt(level, "Bitrate");      
      representation.id = (i + j).toString();
      representation.duration = duration;
      representation.timescale = timeScale;
      representation.segmentTemplate.timescale = timeScale;
      representation.trackId = 1;
      representation.contentProtections = [
        { pssh: null, schemeIdUri: "urn:uuid:EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED", value: null, contentId: prKID } ];
      
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
  var codecs = null;
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
      "text"  : "text/vtt"
  };
  
  mimeType = mimeTypeMap[contentType];
  
  lang = streamElement.getAttribute('Language') || null;
  
  switch (lang) {
    case "por":
      lang = "pt-br";
      main = true;
      break;
    case "eng":
      lang = "en-us"
      main = false;
      break;
    case "esp":
      lang = "es-es"
      break;
    default:    
  }
  
  templateId = (streamElement.getAttribute('Name') || contentType);
  
  segmentTemplate = {
    indexUrlTemplate: null,
    initializationUrlTemplate: "QualityLevels($Bandwidth$)/Fragments(" + templateId + "=0)",
    mediaUrlTemplate: "QualityLevels($Bandwidth$)/Fragments(" + templateId + "=$Time$)",
    presentationTimeOffset: null,
    segmentDuration: 0,
    startNumber: 1,
    timeline: { timePoints: [] }
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
    var entry = { duration: duration, repeat: repeat > 0 ? repeat : null, startTime: null };
    segmentTemplate.timeline.timePoints.push(entry);
  }
  
  return {
    baseUrl: shaka.dash.mss.baseUrl,
    codecs: codecs,
    codecPrivateData: qualityLevel.getAttribute("CodecPrivateData"),
    contentType: contentType,
    height: height,
    id: null,
    lang: lang,
    main: main,
    mimeType: mimeType,
    segmentBase: segmentBase,
    segmentList: segmentList,
    segmentTemplate: segmentTemplate,
    trackId: 1, // Must start from 1
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

uux.byteArrayToAsciiOnlyString = function(byteArray)
{
  var asciiString = "";
  for (var i = 0; i < byteArray.length; i++) {
    var byte = byteArray[i];
    if (byte >= 32 && byte <= 126) {
      asciiString += String.fromCharCode(byte);
    }
  }
  return asciiString;
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