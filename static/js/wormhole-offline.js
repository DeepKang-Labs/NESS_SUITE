(function () {
  'use strict';
  var DEFAULT_BUNDLE =
'<?xml version="1.0" encoding="UTF-8"?>\n' +
'<worm version="1.0" type="node">\n' +
'  <meta>\n' +
'    <schema>worm:node:1.0</schema>\n' +
'    <owner>id:example</owner>\n' +
'    <created>' + new Date().toISOString().replace(/\.\d+Z$/, 'Z') + '</created>\n' +
'  </meta>\n' +
'  <transport>\n' +
'    <inet>198.51.100.42</inet>\n' +
'    <skywire>02000000000000000000000000000000000000000000000000000000000000000</skywire>\n' +
'  </transport>\n' +
'  <services>prng,files</services>\n' +
'</worm>';

  var $ = function (id) { return document.getElementById(id); };
  var state = { a: null, b: null, svgA: '', svgB: '', locked: true };

  /* fatal locks the tool and is only for a failed self-test. A bad input is a problem,
     not a reason to brick the page. */
  function fatal(msg) {
    var el = $('fatal');
    el.textContent = msg; el.style.display = 'block';
    $('seal-btn').disabled = true; $('open-btn').disabled = true;
  }
  function problem(msg) {
    var el = $('fatal');
    el.textContent = msg; el.style.display = msg ? 'block' : 'none';
  }

  function chip(which) {
    var v = $('in-' + which).value.trim();
    var el = $('chip-' + which);
    var got = v.indexOf('NWH1:' + which.toUpperCase() + ':') === 0;
    el.textContent = got ? 'got it' : (v ? 'not this one' : 'waiting');
    el.className = 'chip' + (got ? ' got' : '');
  }

  var stream = null;
  function stopCam() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    $('cam').style.display = 'none';
  }
  async function scanInto(which) {
    if (!('BarcodeDetector' in window)) {
      $('verdict').innerHTML = '<span class="lead un">This browser cannot use the camera</span>' +
        '<span class="why">No reader built in. Type the codes under "show the checks", or open this in NESS Shell.</span>';
      return;
    }
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
    catch (e) {
      $('verdict').innerHTML = '<span class="lead un">The camera stayed shut</span>' +
        '<span class="why">' + e.message + '</span>';
      return;
    }
    var v = $('cam'); v.style.display = 'block'; v.srcObject = stream; await v.play();
    var det = new window.BarcodeDetector({ formats: ['qr_code'] });
    (function tick() {
      if (!stream) return;
      det.detect(v).then(function (codes) {
        if (codes && codes.length) {
          $('in-' + which).value = codes[0].rawValue.trim();
          chip(which); stopCam();
        } else requestAnimationFrame(tick);
      }).catch(function () { requestAnimationFrame(tick); });
    })();
  }

  function say(tone, lead, why) {
    $('verdict').innerHTML = '<span class="lead ' + tone + '">' + lead + '</span>' +
      '<span class="why">' + why + '</span>';
  }

  function gate(rows) {
    var body = $('gate-body');
    body.innerHTML = '';
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      var cls = r.checked === false ? 'un' : (r.ok ? 'ok' : 'no');
      var st = r.checked === false ? 'not checked' : (r.ok ? 'pass' : 'FAIL');
      tr.innerHTML = '<td>' + r.name + '</td><td class="st ' + cls + '">' + st + '</td><td>' + r.detail + '</td>';
      body.appendChild(tr);
    });
    $('gate-table').style.display = '';
  }

  function drawQR(hostId, metaId, text, label) {
    var host = $(hostId);
    host.innerHTML = '';
    try {
      var q = QR.encode(text, { ecl: 'L' });
      host.innerHTML = QR.toSVG(q, { scale: 4, label: label });
      $(metaId).textContent = 'v' + q.version + ' ECC-L · ' + q.bytes + ' bytes · mask ' + q.mask;
      return host.firstChild.outerHTML;
    } catch (e) {
      $(metaId).textContent = '';
      host.innerHTML = '<div class="st no">no symbol: ' + e.message + '</div>';
      return '';
    }
  }

  function download(name, content, type) {
    var blob = new Blob([content], { type: type });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  /* EmerSSH list syntax per emcssh(8): elements separated by |, each either a literal
     public key or an @reference resolved from the NVS record ssh:<name>, recursively. */
  function parseList(str) {
    var bad = [], parts = String(str).split('|').map(function (p) { return p.trim(); })
      .filter(function (p) { return p.length; });
    parts.forEach(function (p) {
      if (p.charAt(0) === '@') {
        if (!/^@[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(p)) bad.push(p + ' is not a usable reference');
      } else if (!/^(ssh-(rsa|dss|ed25519)|ecdsa-sha2-\S+|sk-\S+)\s+\S+/.test(p)) {
        bad.push('"' + p.slice(0, 24) + '…" is neither a reference nor a public key');
      }
    });
    return { parts: parts, bad: bad };
  }

  function emcsshSetup(list) {
    return [
      'Enforcing EmerSSH on this node',
      '==============================',
      '',
      'Access list carried in the bundle:',
      '',
      '  ' + list,
      '',
      'Each element is either a literal public key or an @reference. A reference @ops is',
      'resolved from the NVS record ssh:ops, whose value may itself be a |-separated list,',
      'which is how a group is built. Resolution is recursive, default depth 30. Revoking',
      'somebody means removing their reference from the group record and updating it — the',
      'change propagates without touching any server.',
      '',
      '1. /etc/emcssh_config',
      '',
      '     emcurl        http://rpcuser:rpcpassword@127.0.0.1:6662/',
      '     ssl_check     1',
      '     verbose       2',
      '     maxkeys       4096',
      '     emcssh_keys   $H/.ssh/emcssh_keys',
      '     recursion     30',
      '',
      '   The RPC URL is deliberately not in the bundle. Point it at this node\'s own',
      '   emercoind. A node that asks somebody else\'s wallet who may log in has not',
      '   enforced anything.',
      '',
      '2. $HOME/.ssh/emcssh_keys',
      '',
      '     ' + list,
      '',
      '3. /etc/ssh/sshd_config',
      '',
      '     AuthorizedKeysCommand      /usr/bin/emcssh',
      '     AuthorizedKeysCommandUser  nobody',
      '     AuthorizedKeysFile         none',
      '     PasswordAuthentication     no',
      '     ChallengeResponseAuthentication no',
      '',
      'The third and fourth lines are the enforcement. Without them emcssh is additive:',
      'sshd still honours the local authorized_keys file, so anything already in it keeps',
      'working and the chain decides nothing. This is the step people skip.',
      '',
      '4. Before you disconnect',
      '',
      '   Keep the current session open. Open a second one and log in through the new path.',
      '   Only reload sshd once that second session works. Locking yourself out of a remote',
      '   node is the normal failure here, and it is not recoverable over the network.',
      '',
      '5. What this does not do',
      '',
      '   It does not prove the references resolve. Run: emcssh <username>, and read the',
      '   keys it prints. If the list is empty, the node will refuse everyone.',
      ''
    ].join('\n');
  }

  async function doSeal() {
    var useSsh = $('emcssh').checked;
    var sshList = $('emcssh-ref').value.trim();
    if (useSsh) {
      var chk = parseList(sshList);
      if (!chk.parts.length) throw new Error('EmerSSH enforcement is on but no list was given. Refusing to seal a node that would lock everyone out.');
      if (chk.bad.length) throw new Error('EmerSSH list: ' + chk.bad.join('; '));
    }
    var raw = $('plain').value;
    if (useSsh && raw.indexOf('</worm>') !== -1 && raw.indexOf('<access') === -1) {
      raw = raw.replace('</worm>',
        '  <access enforce="emcssh" list="' + sshList.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;') + '"/>\n</worm>');
      $('plain').value = raw;
    }
    var plain = CORE.utf8(raw);
    var K = CORE.randomBytes(32);
    var salt = CORE.randomBytes(16);
    var nonce = CORE.randomBytes(12);
    var triple = await CORE.tripleFrom(K, salt);
    var key = await CORE.hkdf(K, salt, 'ness-wormhole-1/seal', 32);
    var aad = CORE.utf8('NWH1|' + triple);
    var ct = await CORE.seal(key, nonce, plain, aad);
    var body = CORE.concat(CORE.concat(salt, nonce), ct);
    var a = 'NWH1:A:' + CORE.b64urlEncode(body);
    var b = 'NWH1:B:' + CORE.b64urlEncode(K);

    $('seal-triple').textContent = triple;
    $('seal-meta').textContent = $('label').value + ' · sealed ' +
      new Date().toISOString().replace(/\.\d+Z$/, 'Z') + ' · ' + plain.length + ' plaintext bytes';
    state.svgA = drawQR('qr-a', 'meta-a', a, 'QR A sealed bundle');
    state.svgB = drawQR('qr-b', 'meta-b', b, 'QR B unlock key');
    $('seal-text').value = a + '\n\n' + b;
    $('seal-out').style.display = '';
    $('emcssh-out').style.display = useSsh ? '' : 'none';
    state.sshSetup = useSsh ? emcsshSetup(sshList) : '';
    $('print-btn').disabled = false;
  }

  async function doOpen() {
    var rawA = $('in-a').value.trim(), rawB = $('in-b').value.trim();
    var expect = $('in-triple').value.trim();
    var rows = [], body = null, K = null;
    $('open-out').style.display = 'none';
    chip('a'); chip('b');

    try {
      if (rawA.indexOf('NWH1:A:') !== 0) throw new Error('missing NWH1:A: prefix');
      body = CORE.b64urlDecode(rawA.slice(7));
      if (body.length < 16 + 12 + 16) throw new Error('too short to hold salt, nonce and tag');
      rows.push({ checked: true, ok: true, name: 'Carrier A', detail: body.length + ' bytes' });
    } catch (e) {
      rows.push({ checked: true, ok: false, name: 'Carrier A', detail: e.message });
      say('no', 'The open code is not readable.', e.message);
      return gate(rows);
    }
    try {
      if (rawB.indexOf('NWH1:B:') !== 0) throw new Error('missing NWH1:B: prefix');
      K = CORE.b64urlDecode(rawB.slice(7));
      if (K.length !== 32) throw new Error('key is ' + K.length + ' bytes, expected 32');
      rows.push({ checked: true, ok: true, name: 'Carrier B', detail: '256-bit key' });
    } catch (e) {
      rows.push({ checked: true, ok: false, name: 'Carrier B', detail: e.message });
      say('no', 'The sealed code is not readable.', e.message);
      return gate(rows);
    }

    var salt = body.subarray(0, 16), nonce = body.subarray(16, 28), ct = body.subarray(28);
    var triple = await CORE.tripleFrom(K, salt);

    if (expect) {
      var match = expect.toLowerCase() === triple.toLowerCase();
      rows.push({
        checked: true, ok: match, name: 'Triple as spoken',
        detail: match ? triple : 'carriers derive ' + triple + ', you were told ' + expect
      });
      if (!match) {
        rows.push({ checked: false, name: 'Seal', detail: 'not attempted: the pairing was rejected first' });
        say('no', 'The words do not match.',
          'This pair says "' + triple + '". You were told "' + expect + '". Stop here and ask.');
        return gate(rows);
      }
    } else {
      rows.push({
        checked: false, name: 'Triple as spoken',
        detail: 'no triple given, so the pairing was never confirmed out of band. Carriers derive ' + triple
      });
    }

    try {
      var key = await CORE.hkdf(K, salt, 'ness-wormhole-1/seal', 32);
      var pt = await CORE.open(key, nonce, ct, CORE.utf8('NWH1|' + triple));
      rows.push({ checked: true, ok: true, name: 'Seal', detail: 'AES-256-GCM tag verified, ' + pt.length + ' bytes' });
      $('plain-out').value = CORE.fromUtf8(pt);
      $('open-out').style.display = '';
      if (expect) say('ok', 'Opened. The two halves match the words you were told.',
        'Nothing was altered on the way here. Who made it is a separate question — this only proves the pair is intact.');
      else say('ok', 'Opened.',
        'Nothing was altered on the way here. Nobody said the words to you, though, so the pairing was never confirmed out loud.');
    } catch (e) {
      rows.push({
        checked: true, ok: false, name: 'Seal',
        detail: 'tag check failed. The carriers do not belong together, or the ciphertext was altered.'
      });
      say('no', 'These two do not go together.',
        'Either the sealed code came from a different object, or the open code was tampered with. Do not use what is inside.');
    }
    rows.push({
      checked: false, name: 'Issuer authority',
      detail: 'out of scope here. Anchor the contents against dpo:PrivateNESS.Network through your own node.'
    });
    gate(rows);
  }

  /* Known-answer self-test on the real path. If it fails, the tool locks rather than pretending. */
  async function selfTest() {
    var K = CORE.randomBytes(32), salt = CORE.randomBytes(16), nonce = CORE.randomBytes(12);
    var t = await CORE.tripleFrom(K, salt);
    if (!/^\d{1,3}-[A-Za-z]+-[A-Za-z]+$/.test(t)) throw new Error('triple shape');
    var key = await CORE.hkdf(K, salt, 'ness-wormhole-1/seal', 32);
    var msg = CORE.utf8('self-test \u2713 \u00e9\u00e0');
    var ct = await CORE.seal(key, nonce, msg, CORE.utf8('NWH1|' + t));
    var pt = await CORE.open(key, nonce, ct, CORE.utf8('NWH1|' + t));
    if (CORE.fromUtf8(pt) !== CORE.fromUtf8(msg)) throw new Error('round trip');
    var rejected = false;
    try { await CORE.open(key, nonce, ct, CORE.utf8('NWH1|000-aardvark-adroitness')); }
    catch (e) { rejected = true; }
    if (!rejected) throw new Error('associated data is not binding the triple');
    var q = QR.encode('NWH1:B:' + CORE.b64urlEncode(K), { ecl: 'L' });
    if (q.size !== q.version * 4 + 17) throw new Error('QR geometry');
    if (CORE.md5hex('abc') !== '900150983cd24fb0d6963f7d28e17f72') throw new Error('md5');
    if (parseList('@jack|@jill|ssh-rsa AAAB3x user@host').bad.length) throw new Error('emcssh list parse');
    if (!parseList('jack').bad.length) throw new Error('emcssh list accepts a bare word');
    if (emcsshSetup('@ops').indexOf('AuthorizedKeysFile         none') === -1) throw new Error('emcssh setup');
  }

  document.querySelectorAll('[data-scan]').forEach(function (b) {
    b.addEventListener('click', function () { scanInto(b.getAttribute('data-scan')); });
  });
  ['a', 'b'].forEach(function (w) {
    $('in-' + w).addEventListener('input', function () { chip(w); });
  });

  $('plain').value = DEFAULT_BUNDLE;
  $('seal-btn').addEventListener('click', function () {
    problem(''); doSeal().catch(function (e) { problem(e.message); });
  });
  $('open-btn').addEventListener('click', function () {
    problem(''); doOpen().catch(function (e) { problem(e.message); });
  });
  $('print-btn').addEventListener('click', function () { window.print(); });
  $('emcssh').addEventListener('change', function () {
    $('emcssh-ref-row').style.display = $('emcssh').checked ? '' : 'none';
  });
  $('dl-emcssh').addEventListener('click', function () {
    if (state.sshSetup) download('emcssh-enforce.txt', state.sshSetup, 'text/plain');
  });
  $('dl-bundle').addEventListener('click', function () {
    download('ness-bundle.xml', $('plain-out').value, 'application/xml');
  });
  document.querySelectorAll('[data-dl]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var which = btn.getAttribute('data-dl');
      var svg = which === 'a' ? state.svgA : state.svgB;
      if (svg) download('ness-wormhole-qr-' + which + '.svg', svg, 'image/svg+xml');
    });
  });

  selfTest().then(function () { state.locked = false; })
    .catch(function (e) { fatal('Self-test failed (' + e.message + '). The tool is locked: it will not seal or open anything it cannot first prove works in this browser.'); });
})();
