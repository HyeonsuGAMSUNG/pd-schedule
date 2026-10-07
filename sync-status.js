/* top-right chip: last Notion sync time, sync/deploy progress, and auto data refresh */
(function(){
  var META_URL = 'data/meta.json';
  var BUILD_API = 'https://api.github.com/repos/HyeonsuGAMSUNG/pd-schedule/pages/builds/latest';
  var META_POLL_MS = 30000;
  var BUILD_POLL_MS = 75000;
  var BUILD_TYPICAL_SEC = 55;

  var meta = null;
  var loadedSyncedAt = null;
  var build = null;
  var buildBackoffUntil = 0;
  var flashUntil = 0;
  var callbacks = [];
  var chip, txt;

  function bust(url){ return url + (url.indexOf('?')>-1 ? '&' : '?') + 'v=' + Date.now(); }

  function fmt(iso){
    var d = new Date(iso);
    if(isNaN(d)) return '';
    var parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Seoul', month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hourCycle:'h23'}).formatToParts(d);
    var o = {};
    parts.forEach(function(p){ o[p.type] = p.value; });
    return o.month + '/' + o.day + ' ' + o.hour + ':' + o.minute;
  }

  function ensureChip(){
    if(chip) return;
    var host = document.querySelector('.top-inner');
    if(!host) return;
    chip = document.createElement('div');
    chip.className = 'sync-chip';
    chip.setAttribute('role', 'status');
    chip.innerHTML = '<span class="dot"></span><span class="txt"></span>';
    txt = chip.querySelector('.txt');
    host.appendChild(chip);
  }

  function render(){
    ensureChip();
    if(!chip) return;
    var now = Date.now();
    var state = 'ok', text;

    if(meta && meta.status === 'syncing' && meta.expectedDoneAt){
      var done = Date.parse(meta.expectedDoneAt);
      var remain = done - now;
      if(remain > 0){
        state = 'busy';
        text = '노션 동기화 중 · 약 ' + Math.max(1, Math.ceil(remain/60000)) + '분 남음';
      } else if(remain > -10*60000){
        state = 'busy';
        text = '노션 동기화 마무리 중 · 곧 반영';
      } else {
        state = 'warn';
        text = '동기화 지연 중 · 마지막 반영 ' + fmt(meta.syncedAt);
      }
    } else if(build && (build.status === 'building' || build.status === 'queued')){
      var elapsed = (now - Date.parse(build.created_at)) / 1000;
      state = 'busy';
      if(elapsed < 150){
        text = '사이트 배포 중 · 약 ' + Math.max(10, Math.round(BUILD_TYPICAL_SEC - elapsed)) + '초 남음';
      } else {
        text = '사이트 배포 중 · 곧 반영';
      }
    } else if(build && build.status === 'errored'){
      state = 'warn';
      text = '배포 오류 · 마지막 반영 ' + (meta ? fmt(meta.syncedAt) : '');
    } else if(now < flashUntil){
      state = 'ok';
      text = '최신 데이터로 갱신됨 · ' + fmt(meta.syncedAt) + ' 기준';
    } else if(meta && meta.syncedAt){
      text = '노션 동기화 · ' + fmt(meta.syncedAt) + ' 기준';
    } else {
      state = 'warn';
      text = '동기화 시각 확인 불가';
    }

    chip.className = 'sync-chip ' + state;
    txt.textContent = text;
  }

  function fetchMeta(){
    return fetch(bust(META_URL), {cache:'no-store'})
      .then(function(r){ if(!r.ok) throw new Error('meta'); return r.json(); })
      .then(function(m){
        meta = m;
        if(loadedSyncedAt === null){
          loadedSyncedAt = m.syncedAt;
        } else if(m.syncedAt !== loadedSyncedAt && m.status !== 'syncing'){
          loadedSyncedAt = m.syncedAt;
          flashUntil = Date.now() + 8000;
          callbacks.forEach(function(fn){ try{ fn(); }catch(e){} });
        }
      })
      .catch(function(){});
  }

  function fetchBuild(){
    if(Date.now() < buildBackoffUntil) return Promise.resolve();
    return fetch(BUILD_API, {cache:'no-store'})
      .then(function(r){
        if(r.status === 403 || r.status === 429){ buildBackoffUntil = Date.now() + 5*60000; throw new Error('rate'); }
        if(!r.ok) throw new Error('build');
        return r.json();
      })
      .then(function(b){ build = b; })
      .catch(function(){});
  }

  function visible(){ return document.visibilityState !== 'hidden'; }

  var ready = fetchMeta().then(function(){ render(); });

  setInterval(function(){ if(visible()) fetchMeta(); }, META_POLL_MS);
  setInterval(function(){ if(visible()) fetchBuild().then(render); }, BUILD_POLL_MS);
  setInterval(render, 1000);
  document.addEventListener('visibilitychange', function(){
    if(visible()){ fetchMeta(); fetchBuild().then(render); }
  });
  fetchBuild().then(render);

  window.PDSync = {
    ready: ready,
    bust: bust,
    onUpdate: function(fn){ callbacks.push(fn); }
  };
})();
