/*
 * Parikrama — Water Quality Monitoring System
 * Live dashboard fed by ThingSpeak channel 3445217.
 */
(function () {
  'use strict';

  /* ================= configuration ================= */

  var CHANNEL    = '3445217';
  var READ_KEY   = 'WKZ0J93CK363A0K8';
  var REFRESH_MS = 5000;   // poll every 5s
  var GPS_STALE_MS = 30 * 60 * 1000;   // beyond this, show map grayscale as "last known location"
  var RAW_POINTS = 100;     // entries pulled for the fallback sparkline
  var MAX_POINTS = 30;      // sparkline is downsampled to at most this many
  var ZOOM       = 17;
  var GEOCODE    = true;    // reverse-geocode the buoy fix via OSM Nominatim

  // field1/2/3 as defined on the channel, paired with the design's labels
  var FIELDS = [
    { key: 'field1', tag: 'Temperature', unit: '°C', dp: 1, out: 'v-temp' },
    { key: 'field2', tag: 'pH',          unit: '',   dp: 1, out: 'v-ph'   },
    { key: 'field3', tag: 'Clarity',     unit: '%',  dp: 0, out: 'v-clar' }
  ];

  var $ = function (id) { return document.getElementById(id); };

  /* ================= corner crop marks ================= */

  document.querySelectorAll('[data-marks]').forEach(function (el) {
    ['tl', 'tr', 'bl', 'br'].forEach(function (pos) {
      var m = document.createElement('span');
      m.className = 'mk ' + pos;
      el.appendChild(m);
    });
  });

  /* ================= map ================= */

  var map = L.map('map', {
    center: [22.0, 79.0],
    zoom: 4,
    zoomSnap: 0,
    zoomDelta: 0.5,
    zoomControl: false,
    attributionControl: true
  });

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  var buoy = L.marker([0, 0], {
    interactive: false,
    keyboard: false,
    opacity: 0,
    icon: L.divIcon({
      className: 'buoy',
      html: '<em></em><span></span>',
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    })
  }).addTo(map);

  var located = false;
  var gpsStamp = null;   // created_at of the most recent GPS fix

  // no fix yet at all — start grayscale until proven otherwise
  // (the coords pill already says "no GPS fix", so gps-time stays empty/hidden)
  document.querySelector('.map-cell').classList.add('stale-location');

  function placeBuoy(lat, lng, at_time) {
    var at = L.latLng(lat, lng);
    buoy.setLatLng(at).setOpacity(1);

    if (!located) {
      map.setView(at, ZOOM);
      located = true;
    } else if (!map.getBounds().pad(-0.15).contains(at)) {
      map.panTo(at);          // drifted out of view — follow it
    }

    $('coords').textContent =
      Math.abs(lat).toFixed(4) + '° ' + (lat >= 0 ? 'N' : 'S') + ', ' +
      Math.abs(lng).toFixed(4) + '° ' + (lng >= 0 ? 'E' : 'W');

    gpsStamp = at_time || gpsStamp;
    updateGpsFreshness();

    reverseGeocode(lat, lng);
  }

  function updateGpsFreshness() {
    var mapCell = document.querySelector('.map-cell');
    var gpsTime = $('gps-time');
    if (!gpsStamp) return;

    var age = Date.now() - new Date(gpsStamp).getTime();
    var stale = age > GPS_STALE_MS;

    if (mapCell) mapCell.classList.toggle('stale-location', stale);
    if (gpsTime) {
      gpsTime.textContent = (stale ? 'Last known location · ' : 'GPS ') + relative(gpsStamp).replace(/^Updated /, 'updated ');
      gpsTime.classList.toggle('stale', stale);
    }
  }

  /* ================= reverse geocoding (place name) ================= */

  var lastGeo = null;

  function reverseGeocode(lat, lng) {
    if (!GEOCODE) return;
    // only re-query when the buoy has actually moved (~>100 m)
    if (lastGeo && Math.abs(lastGeo[0] - lat) < 0.001 && Math.abs(lastGeo[1] - lng) < 0.001) return;
    lastGeo = [lat, lng];

    var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16' +
              '&lat=' + lat + '&lon=' + lng;

    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (g) {
        var a = g.address || {};
        var spot = a.water || a.bay || a.reservoir || a.natural ||
                   a.suburb || a.neighbourhood || a.village || a.town ||
                   a.city_district || a.county;
        var city = a.city || a.town || a.state_district || a.state;

        var title = [spot, city].filter(Boolean).filter(function (v, i, arr) {
          return arr.indexOf(v) === i;
        }).join(', ');

        if (title) $('place').textContent = title;

        var near = a.road || a.neighbourhood || a.suburb || a.hamlet;
        $('detail').textContent = near ? 'near ' + near : $('coords').textContent;
      })
      .catch(function () {
        $('detail').textContent = $('coords').textContent;
      });
  }

  /* ================= sparklines ================= */

  var W = 100, H = 40, PAD = 4;
  var chartEls = {};

  FIELDS.forEach(function (f) {
    var el = document.createElement('div');
    el.className = 'chart';
    el.innerHTML =
      '<div class="tag">' + f.tag + '</div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<polyline points=""/>' +
      '</svg>' +
      '<div class="scale"><span></span><span></span></div>';
    $('charts').appendChild(el);

    chartEls[f.key] = {
      line: el.querySelector('polyline'),
      lo:   el.querySelector('.scale span:first-child'),
      hi:   el.querySelector('.scale span:last-child')
    };
  });

  function drawChart(f, values) {
    var c = chartEls[f.key];

    if (values.length < 2) {
      c.line.setAttribute('points', '');
      c.lo.textContent = c.hi.textContent = '';
      return;
    }

    var lo = Math.min.apply(null, values);
    var hi = Math.max.apply(null, values);
    var span = hi - lo;

    var pts = values.map(function (v, i) {
      var x = (i / (values.length - 1)) * W;
      var y = span ? PAD + (1 - (v - lo) / span) * (H - PAD * 2) : H / 2;
      return x.toFixed(2) + ',' + y.toFixed(2);
    }).join(' ');

    c.line.setAttribute('points', pts);
    c.lo.textContent = lo.toFixed(f.dp) + f.unit;
    c.hi.textContent = hi.toFixed(f.dp) + f.unit;
  }

  /* ================= data plumbing ================= */

  function api(query) {
    return 'https://api.thingspeak.com/channels/' + CHANNEL +
           '/feeds.json?api_key=' + READ_KEY + '&' + query +
           '&_=' + Date.now();                     // defeat any intermediate cache
  }

  function getJSON(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // most recent entry whose given key parses as a finite number
  function latestNumber(feeds, key) {
    for (var i = feeds.length - 1; i >= 0; i--) {
      var v = parseFloat(feeds[i][key]);
      if (isFinite(v)) return { value: v, at: feeds[i].created_at };
    }
    return null;
  }

  // ~11m tolerance — treats repeated transmissions of the same fix as unchanged
  var SAME_FIX_EPS = 0.0001;

  function latestFix(feeds) {
    var i;
    for (i = feeds.length - 1; i >= 0; i--) {
      var la = parseFloat(feeds[i].latitude);
      var lo = parseFloat(feeds[i].longitude);
      // ThingSpeak reports 0,0 for "no fix" as well as null
      if (isFinite(la) && isFinite(lo) && (la !== 0 || lo !== 0)) break;
    }
    if (i < 0) return null;

    var la = parseFloat(feeds[i].latitude);
    var lo = parseFloat(feeds[i].longitude);
    var at = feeds[i].created_at;

    // the device may resend the same fix on every entry — the true "last
    // update" is when this coordinate first appeared in this unbroken run,
    // not the timestamp of the most recent repeat of it
    for (var j = i - 1; j >= 0; j--) {
      var jla = parseFloat(feeds[j].latitude);
      var jlo = parseFloat(feeds[j].longitude);
      if (!isFinite(jla) || !isFinite(jlo)) break;
      if (Math.abs(jla - la) > SAME_FIX_EPS || Math.abs(jlo - lo) > SAME_FIX_EPS) break;
      at = feeds[j].created_at;
    }

    return [la, lo, at];
  }

  function numbers(feeds, key) {
    return feeds.map(function (f) { return parseFloat(f[key]); })
                .filter(function (v) { return isFinite(v); });
  }

  function downsample(values, max) {
    if (values.length <= max) return values;
    var out = [];
    for (var i = 0; i < max; i++) {
      out.push(values[Math.round(i * (values.length - 1) / (max - 1))]);
    }
    return out;
  }

  // the daily-average endpoint emits empty buckets and a duplicated tail
  function cleanDaily(feeds) {
    var seen = {};
    return (feeds || []).filter(function (f) {
      if (seen[f.created_at]) return false;
      seen[f.created_at] = true;
      return FIELDS.some(function (x) { return isFinite(parseFloat(f[x.key])); });
    });
  }

  /* ================= render ================= */

  function relative(iso) {
    var secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 0) secs = 0;
    if (secs < 60)    return 'Updated ' + secs + ' second' + (secs === 1 ? '' : 's') + ' ago';
    var mins = Math.round(secs / 60);
    if (mins < 60)    return 'Updated ' + mins + ' minute' + (mins === 1 ? '' : 's') + ' ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24)     return 'Updated ' + hrs + ' hour' + (hrs === 1 ? '' : 's') + ' ago';
    var days = Math.round(hrs / 24);
    return 'Updated ' + days + ' day' + (days === 1 ? '' : 's') + ' ago';
  }

  var lastStamp = null;

  function tick() {
    updateGpsFreshness();
    var ago = $('ago');
    if (!lastStamp || ago.classList.contains('err')) return;
    ago.textContent = relative(lastStamp);
  }

  function fail(msg) {
    var ago = $('ago');
    ago.className = 'err';
    ago.textContent = msg;
    document.querySelectorAll('.metric, .chart').forEach(function (el) {
      el.classList.add('stale');
    });
  }

  function load() {
    Promise.all([
      getJSON(api('results=' + RAW_POINTS + '&location=true')),
      getJSON(api('days=7&average=1440')).catch(function () { return null; })
    ])
    .then(function (res) {
      var raw   = (res[0] && res[0].feeds) || [];
      var daily = cleanDaily(res[1] && res[1].feeds);

      if (!raw.length) { fail('No readings on this channel'); return; }

      document.querySelectorAll('.metric, .chart').forEach(function (el) {
        el.classList.remove('stale');
      });
      $('ago').className = '';

      // ---- current values ----
      var newest = null;

      FIELDS.forEach(function (f) {
        var hit = latestNumber(raw, f.key);
        $(f.out).textContent = hit ? hit.value.toFixed(f.dp) : '—';
        if (hit && (!newest || new Date(hit.at) > new Date(newest))) newest = hit.at;
      });

      lastStamp = newest || raw[raw.length - 1].created_at;
      tick();

      // ---- location ----
      var fix = latestFix(raw);
      if (fix) {
        placeBuoy(fix[0], fix[1], fix[2]);
      } else if (!located) {
        // never had a fix at all — nothing to fall back to
        $('coords').textContent = 'no GPS fix';
        $('detail').textContent = res[0].channel.name || 'unknown location';
        $('gps-time').textContent = '';
        document.querySelector('.map-cell').classList.add('stale-location');
      } else {
        // had a fix before, none in this batch — keep showing the last known one
        updateGpsFreshness();
      }

      // ---- trends: prefer daily averages, fall back to raw entries ----
      var useDaily = daily.length >= 3;

      $('trend-title').textContent = useDaily
        ? 'Trends · Last 7 days'
        : 'Trends · Last ' + Math.min(raw.length, MAX_POINTS) + ' readings';

      FIELDS.forEach(function (f) {
        var vals = useDaily ? numbers(daily, f.key)
                            : downsample(numbers(raw, f.key), MAX_POINTS);
        drawChart(f, vals);
      });
    })
    .catch(function (e) {
      fail('Feed unavailable — retrying');
      console.error('[parikrama] ThingSpeak fetch failed:', e);
    });
  }

  load();
  setInterval(load, REFRESH_MS);
  setInterval(tick, 15000);

  window.addEventListener('resize', function () { map.invalidateSize(); });
})();
