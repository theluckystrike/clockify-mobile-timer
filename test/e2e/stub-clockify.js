(function (app, id) {
  var p = app.plugins.plugins[id];
  var WS = 'a1b2c3d4e5f6a1b2c3d4e5f6';
  var UID = '0a0b0c0d0e0f0a0b0c0d0e0f';
  var d = new Date(); d.setHours(14, 0, 0, 0);
  var base = d.getTime();
  var real0 = Date.now();
  p.service.deps.now = function () { return base + (Date.now() - real0); };
  p.service.deps.client.opts.now = p.service.deps.now;
  var mid = new Date(base); mid.setHours(0, 0, 0, 0);
  var d0 = mid.getTime();
  var at = function (h, m) { return d0 + (h * 60 + m) * 60000; };
  var iso = function (ms) { return new Date(ms).toISOString().replace('.000Z', 'Z'); };
  var projects = [
    { id: '5b641568b07987035750505e', workspaceId: WS, name: 'Docs', color: '#06a893', archived: false },
    { id: '5b641568b07987035750505f', workspaceId: WS, name: 'Code', color: '#c7561e', archived: false },
    { id: '5b641568b07987035750506a', workspaceId: WS, name: 'Planning', color: '#2da608', archived: false }
  ];
  var st = { calls: [], mode: 'ok', next: 1, entries: [], projects: projects, now: p.service.deps.now };
  var newId = function () { return 'ee' + String(st.next++).padStart(22, '0'); };
  // A stored entry. view() gives the wire shape of Clockify: only the list calls are hydrated (they embed the project).
  var mk = function (o) {
    return { id: o.id || newId(), description: o.d, projectId: o.p || null, tagIds: o.t || [], start: o.s, end: o.e || null };
  };
  var view = function (e, hydrated) {
    var w = { id: e.id, description: e.description, userId: UID, workspaceId: WS, projectId: e.projectId, taskId: null, tagIds: e.tagIds, billable: false, timeInterval: { start: iso(e.start), end: e.end ? iso(e.end) : null, duration: null } };
    var pr = projects.filter(function (x) { return x.id === e.projectId; })[0];
    if (hydrated && pr) w.project = { id: pr.id, name: pr.name, color: pr.color };
    return w;
  };
  st.entries = [
    mk({ d: 'Write README', s: at(8, 30), e: at(9, 15), p: projects[0].id }),
    mk({ d: 'Fix sync bug', s: at(9, 30), e: at(10, 45), p: projects[1].id }),
    mk({ d: 'Review notes', s: at(11, 0), e: at(11, 40), p: projects[0].id })
  ];
  st.ids = { ws: WS, uid: UID, docs: projects[0].id, code: projects[1].id };
  var running = function () { return st.entries.filter(function (e) { return !e.end; })[0] || null; };
  var idOf = function (path) { var m = /time-entries\/([0-9a-f]{24})/.exec(path); return m ? m[1] : ''; };
  p.service.deps.client.opts.http = function (r) {
    st.calls.push({ method: r.method, path: r.path, body: r.body ? JSON.parse(r.body) : null, key: r.headers['X-Api-Key'], auth: r.headers.Authorization });
    var h = { 'Last-Page': 'true' };
    if (st.mode === 'offline') return Promise.resolve({ status: 0, json: null, headers: {} });
    if (st.mode === '429') return Promise.resolve({ status: 429, json: { message: 'Too many requests', code: 429 }, headers: {} });
    if (st.mode === '503') return Promise.resolve({ status: 503, json: null, headers: {} });
    var ok = function (j, status) { return Promise.resolve({ status: status || 200, json: j, headers: h }); };
    var body = r.body ? JSON.parse(r.body) : {};
    var userList = '/workspaces/' + WS + '/user/' + UID + '/time-entries';
    if (r.method === 'GET' && r.path === '/user') return ok({ id: UID, name: 'Demo User', defaultWorkspace: WS, activeWorkspace: WS });
    if (r.method === 'GET' && r.path.indexOf(userList + '?') === 0 && r.path.indexOf('in-progress=true') > 0) { var cur = running(); return ok(cur ? [view(cur, true)] : []); }
    if (r.method === 'GET' && r.path.indexOf(userList + '?') === 0) return ok(st.entries.map(function (e) { return view(e, true); }));
    if (r.method === 'GET' && r.path.indexOf('/workspaces/' + WS + '/projects?') === 0) return ok(projects);
    if (r.method === 'GET' && r.path.indexOf('/workspaces/' + WS + '/tags?') === 0) return ok([{ id: '7e4117fe8c625f38930d57b7', name: 'deep work', workspaceId: WS, archived: false }, { id: '7e4117fe8c625f38930d57b8', name: 'review', workspaceId: WS, archived: false }]);
    if (r.method === 'POST' && r.path === '/workspaces/' + WS + '/time-entries') {
      var e = mk({ d: body.description, s: Date.parse(body.start), e: body.end ? Date.parse(body.end) : 0, p: body.projectId, t: body.tagIds });
      st.entries.push(e);
      return ok(view(e, false), 201);
    }
    if (r.method === 'PATCH' && r.path === userList) {
      var s = running();
      if (s) s.end = Date.parse(body.end);
      return ok(s ? view(s, false) : null);
    }
    if (r.method === 'PUT') {
      var u = st.entries.filter(function (x) { return x.id === idOf(r.path); })[0];
      if (u) {
        u.description = body.description; u.start = Date.parse(body.start); u.end = body.end ? Date.parse(body.end) : null;
        u.projectId = body.projectId || null; u.tagIds = body.tagIds || [];
      }
      return ok(u ? view(u, false) : null);
    }
    if (r.method === 'DELETE') {
      var gone = idOf(r.path);
      st.entries = st.entries.filter(function (x) { return x.id !== gone; });
      return ok(null, 204);
    }
    return Promise.resolve({ status: 404, json: { message: 'no such route' }, headers: h });
  };
  app.secretStorage.setSecret(p.settings.tokenSecretId, 'stub-key-0000');
  st.mk = mk;
  window.__tmtStub = st;
  return 'ok';
})(app, 'clockify-mobile-timer')
