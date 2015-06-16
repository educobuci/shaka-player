shaka.dash.MssRequest = function(url) {
  shaka.util.AjaxRequest.call(this, url);
  this.parameters.responseType = 'text';
  this.parameters.maxAttempts = 3;
  this.parameters.requestTimeoutMs = shaka.dash.MssRequest.requestTimeoutMs;
};

goog.inherits(shaka.dash.MssRequest, shaka.util.AjaxRequest);

shaka.dash.MssRequest.requestTimeoutMs = 0;

shaka.dash.MssRequest.prototype.send = function() {
  var url = this.url;
  return this.sendInternal().then(
      /** @param {!XMLHttpRequest} xhr */
      function(xhr) {
        var mpd = shaka.dash.mss.parseMss(xhr.responseText, url);
        if (mpd) {
          return Promise.resolve(mpd);
        }

        var error = new Error('MSS/MPD parse failure.');
        error.type = 'mpd';
        return Promise.reject(error);
      }
  );
};
