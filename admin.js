/* 관리자 편집 공용 모듈 (all.html / schedule.html / index.html 에서 공유)
 *  - 비밀번호는 서버로 보내지 않고, 이 기기에 AES-GCM으로 암호화해 둔 GitHub 토큰을 여는 데만 써요.
 *  - 저장은 GitHub API로 data/*.json 파일을 직접 수정(commit)해요. Claude와 무관하게 동작해요.
 */
window.PDAdmin = (function(){
  var GH = {owner:'HyeonsuGAMSUNG', repo:'pd-schedule', branch:'main'};
  var LS_KEY = 'pd_admin_v1';
  var S = {on:false, token:null, shas:{}, dirty:{}, pending:[]};
  var opts = null;

  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ---------- 인코딩 / 암호화 ----------
  function b64e(str){
    var bytes = new TextEncoder().encode(str), bin = '';
    for(var i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64d(b64){
    var bin = atob(b64.replace(/\s/g,'')), bytes = new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function u8ToB64(u8){ var s=''; for(var i=0;i<u8.length;i++) s += String.fromCharCode(u8[i]); return btoa(s); }
  function b64ToU8(b){ var s=atob(b), u=new Uint8Array(s.length); for(var i=0;i<s.length;i++) u[i]=s.charCodeAt(i); return u; }
  function deriveKey(pw, salt){
    return crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']).then(function(km){
      return crypto.subtle.deriveKey({name:'PBKDF2', salt:salt, iterations:250000, hash:'SHA-256'}, km, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
    });
  }
  function encryptToken(token, pw){
    var salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    return deriveKey(pw, salt).then(function(key){
      return crypto.subtle.encrypt({name:'AES-GCM', iv:iv}, key, new TextEncoder().encode(token));
    }).then(function(buf){ return {s:u8ToB64(salt), i:u8ToB64(iv), c:u8ToB64(new Uint8Array(buf))}; });
  }
  function decryptToken(blob, pw){
    return deriveKey(pw, b64ToU8(blob.s)).then(function(key){
      return crypto.subtle.decrypt({name:'AES-GCM', iv:b64ToU8(blob.i)}, key, b64ToU8(blob.c));
    }).then(function(buf){ return new TextDecoder().decode(buf); });
  }
  function getBlob(){ try{ var v = localStorage.getItem(LS_KEY); return v ? JSON.parse(v) : null; }catch(e){ return null; } }
  function setBlob(b){ try{ localStorage.setItem(LS_KEY, JSON.stringify(b)); return true; }catch(e){ return false; } }
  function clearBlob(){ try{ localStorage.removeItem(LS_KEY); }catch(e){} }

  function gh(path, o){
    o = o || {};
    var headers = {'Accept':'application/vnd.github+json', 'Authorization':'Bearer '+S.token};
    if(o.body) headers['Content-Type'] = 'application/json';
    return fetch('https://api.github.com/repos/'+GH.owner+'/'+GH.repo+path, {method:o.method||'GET', headers:headers, body:o.body, cache:'no-store'});
  }

  // ---------- 토스트 / 모달 ----------
  function toast(msg){
    var t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(function(){ if(t.parentNode) t.parentNode.removeChild(t); }, 4200);
  }
  function closeModal(){ var b = document.getElementById('modalBg'); if(b) b.parentNode.removeChild(b); }
  function openModal(html){
    closeModal();
    var bg = document.createElement('div'); bg.className = 'modal-bg'; bg.id = 'modalBg';
    bg.innerHTML = '<div class="modal" role="dialog">'+html+'</div>';
    bg.addEventListener('click', function(ev){ if(ev.target===bg) closeModal(); });
    document.body.appendChild(bg);
    return bg.firstChild;
  }

  // ---------- 파일 읽기 / 저장 ----------
  function fetchFile(path, key){
    return gh('/contents/'+path+'?ref='+GH.branch).then(function(r){
      if(!r.ok) throw new Error(path+' 읽기 실패 ('+r.status+')');
      return r.json();
    }).then(function(j){ S.shas[key] = j.sha; return JSON.parse(b64d(j.content)); });
  }
  function loadPacks(ids){
    return Promise.all(ids.map(function(id){
      return fetchFile('data/'+id+'.json', id).then(function(ev){ return {id:id, events:ev}; });
    }));
  }
  function serialize(arr){
    var a = arr.slice().sort(function(x,y){
      if(x.date!==y.date) return x.date<y.date?-1:1;
      var tx = x.time||'', ty = y.time||''; return tx<ty?-1:(tx>ty?1:0);
    });
    if(!a.length) return '[]\n';
    return '[\n'+a.map(function(e){ return JSON.stringify(e); }).join(',\n')+'\n]\n';
  }
  function putFile(path, text, sha, message){
    var body = {message:message, content:b64e(text), branch:GH.branch};
    if(sha) body.sha = sha;
    return gh('/contents/'+path, {method:'PUT', body:JSON.stringify(body)}).then(function(r){
      if(r.status===409 || r.status===422) throw new Error('다른 곳에서 먼저 일정이 바뀌었어요. [되돌리기]로 최신 일정을 다시 불러온 뒤 다시 편집해 주세요.');
      if(r.status===401 || r.status===403) throw new Error('토큰 권한이 없거나 만료됐어요. 나가기 후 관리자 설정을 새 토큰으로 다시 해 주세요.');
      if(!r.ok) throw new Error('저장 실패 ('+r.status+')');
      return r.json();
    });
  }

  // ---------- 인증 ----------
  function showAuth(){
    var blob = getBlob();
    if(!window.crypto || !crypto.subtle){ toast('이 브라우저에서는 관리자 기능을 쓸 수 없어요 (https 필요)'); return; }
    if(blob){
      var m = openModal('<h3>관리자 잠금 해제</h3><label>비밀번호<input type="password" id="admPw" autocomplete="current-password"></label>'
        + '<div class="err" id="admErr" style="display:none"></div>'
        + '<div class="btns"><button type="button" id="admCancel">취소</button><button type="button" class="pri" id="admOk">열기</button></div>'
        + '<div class="hint"><a href="#" id="admReset">이 기기의 관리자 설정 지우기</a></div>');
      var pw = m.querySelector('#admPw'); pw.focus();
      var go = function(){
        var err = m.querySelector('#admErr'); err.style.display = 'none';
        decryptToken(blob, pw.value).then(function(tok){ enter(tok); }).catch(function(){
          err.textContent = '비밀번호가 맞지 않아요.'; err.style.display = 'block';
        });
      };
      m.querySelector('#admOk').addEventListener('click', go);
      pw.addEventListener('keydown', function(e){ if(e.key==='Enter') go(); });
      m.querySelector('#admCancel').addEventListener('click', closeModal);
      m.querySelector('#admReset').addEventListener('click', function(e){
        e.preventDefault();
        if(confirm('이 기기에 저장된 관리자 설정(암호화된 토큰)을 지울까요?')){ clearBlob(); closeModal(); toast('관리자 설정을 지웠어요'); }
      });
    } else {
      var s = openModal('<h3>관리자 최초 설정 (이 기기에서 1번만)</h3>'
        + '<label>GitHub 토큰<input type="password" id="admTok" autocomplete="off" placeholder="github_pat_..."></label>'
        + '<label>새 관리자 비밀번호<input type="password" id="admPw1" autocomplete="new-password"></label>'
        + '<label>비밀번호 확인<input type="password" id="admPw2" autocomplete="new-password"></label>'
        + '<div class="err" id="admErr" style="display:none"></div>'
        + '<div class="btns"><button type="button" id="admCancel">취소</button><button type="button" class="pri" id="admOk">저장하고 열기</button></div>'
        + '<div class="hint"><b>토큰이 뭐예요?</b> GitHub가 "이 열쇠를 가진 사람은 이 사이트의 일정 파일을 고쳐도 된다"고 인정해 주는 긴 암호예요. 처음 한 번만 아래에서 만들어 붙여 넣어요.<br>'
        + '1) <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">여기를 눌러 토큰 만들기</a> (GitHub 로그인 필요)<br>'
        + '2) Token name: 아무 이름(예: pd-site) · Expiration: 1년 정도<br>'
        + '3) Repository access: <b>Only select repositories</b> → <b>pd-schedule</b> 선택<br>'
        + '4) Permissions → Repository permissions → <b>Contents</b>를 <b>Read and write</b>로<br>'
        + '5) 맨 아래 Generate token → 나온 <b>github_pat_...</b> 문자열을 복사해 위 칸에 붙여넣기<br>'
        + '토큰은 비밀번호로 암호화되어 <b>이 기기 브라우저에만</b> 저장돼요. 다른 기기(폰/PC)는 그 기기에서 한 번씩 더 설정해요.</div>');
      s.querySelector('#admCancel').addEventListener('click', closeModal);
      s.querySelector('#admOk').addEventListener('click', function(){
        var err = s.querySelector('#admErr'); err.style.display = 'none';
        var tok = s.querySelector('#admTok').value.trim(), p1 = s.querySelector('#admPw1').value, p2 = s.querySelector('#admPw2').value;
        var fail = function(t){ err.textContent = t; err.style.display = 'block'; };
        if(!tok) return fail('토큰을 입력해 주세요.');
        if(p1.length < 8) return fail('비밀번호는 8자 이상으로 해 주세요.');
        if(p1 !== p2) return fail('비밀번호 확인이 달라요.');
        S.token = tok;
        gh('').then(function(r){
          if(!r.ok) throw new Error('토큰으로 저장소에 접근할 수 없어요 ('+r.status+'). 토큰을 다시 확인해 주세요.');
          return r.json();
        }).then(function(repo){
          if(!repo.permissions || !repo.permissions.push) throw new Error('이 토큰에는 쓰기 권한(Contents: Read and write)이 없어요.');
          return encryptToken(tok, p1);
        }).then(function(b){
          if(!setBlob(b)) throw new Error('이 브라우저에 저장할 수 없어요 (사생활 보호 모드?).');
          enter(tok);
        }).catch(function(e){ S.token = null; fail(e.message || '설정에 실패했어요.'); });
      });
    }
  }

  function enter(tok){
    S.token = tok;
    openModal('<h3>일정 불러오는 중…</h3><div class="hint">GitHub에서 최신 일정을 직접 읽어 와요.</div>');
    Promise.resolve(opts.onEnter()).then(function(){
      S.on = true; S.dirty = {}; S.pending = [];
      document.body.classList.add('adm-on');
      opts.btn.textContent = '편집 중'; opts.btn.classList.add('on');
      closeModal(); buildBar(); opts.rerender();
      toast('편집 모드예요. [수정] [날짜 이동] [삭제] 버튼으로 고치고 아래 [저장]을 눌러요.');
    }).catch(function(e){ S.token = null; closeModal(); toast('불러오기에 실패했어요: '+(e.message||e)); });
  }

  function exit(force){
    if(!force && Object.keys(S.dirty).length && !confirm('저장하지 않은 변경이 있어요. 버리고 나갈까요?')) return;
    S.on = false; S.token = null; S.dirty = {}; S.pending = [];
    document.body.classList.remove('adm-on');
    opts.btn.textContent = '관리자'; opts.btn.classList.remove('on');
    var bar = document.getElementById('admBar'); if(bar) bar.parentNode.removeChild(bar);
    if(opts.onExit) opts.onExit();
  }

  // ---------- 하단 바 ----------
  function buildBar(){
    var bar = document.getElementById('admBar');
    if(!bar){ bar = document.createElement('div'); bar.id = 'admBar'; bar.className = 'admbar'; document.body.appendChild(bar); }
    bar.innerHTML = '<span class="txt" id="admTxt"></span>'
      + '<button type="button" id="admUndo">되돌리기</button>'
      + '<button type="button" class="pri" id="admSave">저장</button>'
      + '<button type="button" id="admOut">나가기</button>';
    bar.querySelector('#admSave').addEventListener('click', saveAll);
    bar.querySelector('#admUndo').addEventListener('click', function(){
      if(!S.pending.length) return;
      if(!confirm('저장하지 않은 변경을 모두 되돌릴까요?')) return;
      Promise.resolve(opts.onEnter()).then(function(){ S.dirty = {}; S.pending = []; opts.rerender(); updateBar(); toast('되돌렸어요'); });
    });
    bar.querySelector('#admOut').addEventListener('click', function(){ exit(false); });
    updateBar();
  }
  function updateBar(){
    if(!S.on) return;
    var n = S.pending.length, t = document.getElementById('admTxt');
    if(t) t.textContent = n ? ('저장 안 된 변경 '+n+'건') : '편집 모드 · 변경 없음';
    var sv = document.getElementById('admSave'), un = document.getElementById('admUndo');
    if(sv) sv.disabled = !n; if(un) un.disabled = !n;
  }
  function log(text, pdIds){
    S.pending.push(text);
    (pdIds||[]).forEach(function(id){ S.dirty[id] = true; });
    updateBar();
  }

  // ---------- 저장 ----------
  function saveAll(){
    var ids = Object.keys(S.dirty);
    if(!ids.length && !S.pending.length) return;
    var sv = document.getElementById('admSave'); sv.disabled = true; sv.textContent = '저장 중…';
    var summary = S.pending.slice(0,3).join(', ')+(S.pending.length>3?' 외 '+(S.pending.length-3)+'건':'');
    var files = opts.getFiles();   // [{key, path, text, isNew}]
    var chain = Promise.resolve();
    files.forEach(function(f){
      if(!S.dirty[f.key]) return;
      chain = chain.then(function(){
        return putFile(f.path, f.text, f.isNew ? null : S.shas[f.key], 'admin: '+summary+' ['+f.key+']').then(function(j){
          S.shas[f.key] = j.content.sha; delete S.dirty[f.key];
        });
      });
    });
    chain.then(function(){
      S.pending = []; sv.textContent = '저장'; updateBar();
      toast('저장했어요. 1분쯤 뒤 모든 사람 화면에 반영돼요.');
      if(opts.onSaved) opts.onSaved();
    }).catch(function(e){
      sv.textContent = '저장'; sv.disabled = false; updateBar(); toast(e.message || '저장에 실패했어요');
    });
  }

  // ---------- 공용 폼 ----------
  function catOptions(sel){
    var C = opts.cats || {};
    return Object.keys(C).map(function(k){ return '<option value="'+k+'"'+(k===sel?' selected':'')+'>'+esc(C[k].label)+'</option>'; }).join('');
  }
  function openEdit(init, onOk){
    var m = openModal('<h3>일정 수정</h3>'
      + '<label>제목<input type="text" id="fTitle" value="'+esc(init.title)+'"></label>'
      + '<label>날짜<input type="date" id="fDate" value="'+init.date+'"></label>'
      + '<label>시간 (비우면 시간 없음)<input type="time" id="fTime" value="'+(init.time||'')+'"></label>'
      + '<label>분류<select id="fCat">'+catOptions(init.category)+'</select></label>'
      + '<label class="chk"><input type="checkbox" id="fBlocks"'+(init.blocks?' checked':'')+'> 수업 있음 (해제하면 일정 아님·초록색)</label>'
      + '<div class="btns"><button type="button" id="fCancel">취소</button><button type="button" class="pri" id="fOk">적용</button></div>');
    m.querySelector('#fCancel').addEventListener('click', closeModal);
    m.querySelector('#fOk').addEventListener('click', function(){
      var title = m.querySelector('#fTitle').value.trim(), date = m.querySelector('#fDate').value;
      if(!title || !date){ toast('제목과 날짜를 입력해 주세요'); return; }
      closeModal();
      onOk({title:title, date:date, time:m.querySelector('#fTime').value || null, category:m.querySelector('#fCat').value, blocks:m.querySelector('#fBlocks').checked});
    });
  }
  // mode 'multi': PD별 역할 선택 / mode 'single': 해당 PD 한 명
  function openAdd(init, onOk){
    var rows = '';
    if(init.mode==='multi'){
      rows = '<label>참여 PD (최소 1명)</label>' + opts.getPds().map(function(p){
        return '<div class="pdrow"><span>'+esc(p.name)+'</span><select data-pd="'+p.id+'"><option value="">-</option><option value="main">강의·진행</option><option value="int">통역</option></select></div>';
      }).join('');
    }
    var m = openModal('<h3>일정 추가</h3>'
      + '<label>제목<input type="text" id="aTitle" placeholder="예: AI 아티스트 9회차"></label>'
      + '<label>날짜<input type="date" id="aDate" value="'+(init.date||'')+'"></label>'
      + '<label>시간 (비우면 시간 없음)<input type="time" id="aTime" value="19:00"></label>'
      + '<label>분류<select id="aCat">'+catOptions(init.category||'album')+'</select></label>'
      + '<label class="chk"><input type="checkbox" id="aBlocks" checked> 수업 있음</label>' + rows
      + '<div class="btns"><button type="button" id="aCancel">취소</button><button type="button" class="pri" id="aOk">추가</button></div>');
    m.querySelector('#aCancel').addEventListener('click', closeModal);
    m.querySelector('#aOk').addEventListener('click', function(){
      var title = m.querySelector('#aTitle').value.trim(), d = m.querySelector('#aDate').value;
      var who = [].slice.call(m.querySelectorAll('select[data-pd]')).filter(function(s){ return s.value; }).map(function(s){ return {pd:s.getAttribute('data-pd'), role:s.value}; });
      if(!title || !d){ toast('제목과 날짜를 입력해 주세요'); return; }
      if(init.mode==='multi' && !who.length){ toast('참여 PD를 1명 이상 골라 주세요'); return; }
      closeModal();
      onOk({title:title, date:d, time:m.querySelector('#aTime').value || null, category:m.querySelector('#aCat').value, blocks:m.querySelector('#aBlocks').checked}, who);
    });
  }

  function init(o){
    opts = o;
    o.btn.addEventListener('click', function(){ if(S.on) exit(false); else showAuth(); });
    window.addEventListener('beforeunload', function(ev){
      if(S.on && S.pending.length){ ev.preventDefault(); ev.returnValue = ''; }
    });
  }

  return {init:init, state:S, esc:esc, toast:toast, openModal:openModal, closeModal:closeModal,
          openEdit:openEdit, openAdd:openAdd, log:log, updateBar:updateBar, loadPacks:loadPacks,
          fetchFile:fetchFile, putFile:putFile, serialize:serialize, isOn:function(){ return S.on; }};
})();
