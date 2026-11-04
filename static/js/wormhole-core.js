/* core.js — shared primitives for the NESS wormhole tools.
   No network. Randomness comes only from crypto.getRandomValues.
   PGP word list: the canonical even/odd lists used by magic-wormhole. */
var CORE = (function () {
  'use strict';

  var PGP_EVEN = ["aardvark","absurd","accrue","acme","adrift","adult","afflict","ahead","aimless","Algol","allow","alone","ammo","ancient","apple","artist","assume","Athens","atlas","Aztec","baboon","backfield","backward","banjo","beaming","bedlamp","beehive","beeswax","befriend","Belfast","berserk","billiard","bison","blackjack","blockade","blowtorch","bluebird","bombast","bookshelf","brackish","breadline","breakup","brickyard","briefcase","Burbank","button","buzzard","cement","chairlift","chatter","checkup","chisel","choking","chopper","Christmas","clamshell","classic","classroom","cleanup","clockwork","cobra","commence","concert","cowbell","crackdown","cranky","crowfoot","crucial","crumpled","crusade","cubic","dashboard","deadbolt","deckhand","dogsled","dragnet","drainage","dreadful","drifter","dropper","drumbeat","drunken","Dupont","dwelling","eating","edict","egghead","eightball","endorse","endow","enlist","erase","escape","exceed","eyeglass","eyetooth","facial","fallout","flagpole","flatfoot","flytrap","fracture","framework","freedom","frighten","gazelle","Geiger","glitter","glucose","goggles","goldfish","gremlin","guidance","hamlet","highchair","hockey","indoors","indulge","inverse","involve","island","jawbone","keyboard","kickoff","kiwi","klaxon","locale","lockup","merit","minnow","miser","Mohawk","mural","music","necklace","Neptune","newborn","nightbird","Oakland","obtuse","offload","optic","orca","payday","peachy","pheasant","physique","playhouse","Pluto","preclude","prefer","preshrunk","printer","prowler","pupil","puppy","python","quadrant","quiver","quota","ragtime","ratchet","rebirth","reform","regain","reindeer","rematch","repay","retouch","revenge","reward","rhythm","ribcage","ringbolt","robust","rocker","ruffled","sailboat","sawdust","scallion","scenic","scorecard","Scotland","seabird","select","sentence","shadow","shamrock","showgirl","skullcap","skydive","slingshot","slowdown","snapline","snapshot","snowcap","snowslide","solo","southward","soybean","spaniel","spearhead","spellbind","spheroid","spigot","spindle","spyglass","stagehand","stagnate","stairway","standard","stapler","steamship","sterling","stockman","stopwatch","stormy","sugar","surmount","suspense","sweatband","swelter","tactics","talon","tapeworm","tempest","tiger","tissue","tonic","topmost","tracker","transit","trauma","treadmill","Trojan","trouble","tumor","tunnel","tycoon","uncut","unearth","unwind","uproot","upset","upshot","vapor","village","virus","Vulcan","waffle","wallet","watchword","wayside","willow","woodlark","Zulu"];
  var PGP_ODD = ["adroitness","adviser","aftermath","aggregate","alkali","almighty","amulet","amusement","antenna","applicant","Apollo","armistice","article","asteroid","Atlantic","atmosphere","autopsy","Babylon","backwater","barbecue","belowground","bifocals","bodyguard","bookseller","borderline","bottomless","Bradbury","bravado","Brazilian","breakaway","Burlington","businessman","butterfat","Camelot","candidate","cannonball","Capricorn","caravan","caretaker","celebrate","cellulose","certify","chambermaid","Cherokee","Chicago","clergyman","coherence","combustion","commando","company","component","concurrent","confidence","conformist","congregate","consensus","consulting","corporate","corrosion","councilman","crossover","crucifix","cumbersome","customer","Dakota","decadence","December","decimal","designing","detector","detergent","determine","dictator","dinosaur","direction","disable","disbelief","disruptive","distortion","document","embezzle","enchanting","enrollment","enterprise","equation","equipment","escapade","Eskimo","everyday","examine","existence","exodus","fascinate","filament","finicky","forever","fortitude","frequency","gadgetry","Galveston","getaway","glossary","gossamer","graduate","gravity","guitarist","hamburger","Hamilton","handiwork","hazardous","headwaters","hemisphere","hesitate","hideaway","holiness","hurricane","hydraulic","impartial","impetus","inception","indigo","inertia","infancy","inferno","informant","insincere","insurgent","integrate","intention","inventive","Istanbul","Jamaica","Jupiter","leprosy","letterhead","liberty","maritime","matchmaker","maverick","Medusa","megaton","microscope","microwave","midsummer","millionaire","miracle","misnomer","molasses","molecule","Montana","monument","mosquito","narrative","nebula","newsletter","Norwegian","October","Ohio","onlooker","opulent","Orlando","outfielder","Pacific","pandemic","Pandora","paperweight","paragon","paragraph","paramount","passenger","pedigree","Pegasus","penetrate","perceptive","performance","pharmacy","phonetic","photograph","pioneer","pocketful","politeness","positive","potato","processor","provincial","proximate","puberty","publisher","pyramid","quantity","racketeer","rebellion","recipe","recover","repellent","replica","reproduce","resistor","responsive","retraction","retrieval","retrospect","revenue","revival","revolver","sandalwood","sardonic","Saturday","savagery","scavenger","sensation","sociable","souvenir","specialist","speculate","stethoscope","stupendous","supportive","surrender","suspicious","sympathy","tambourine","telephone","therapist","tobacco","tolerance","tomorrow","torpedo","tradition","travesty","trombonist","truncated","typewriter","ultimate","undaunted","underfoot","unicorn","unify","universe","unravel","upcoming","vacancy","vagabond","vertigo","Virginia","visitor","vocalist","voyager","warranty","Waterloo","whimsical","Wichita","Wilmington","Wyoming","yesteryear","Yucatan"];

  function need(cond, msg) { if (!cond) throw new Error(msg); }

  /* ---- entropy ---- */
  function randomBytes(n) {
    need(typeof crypto !== 'undefined' && crypto.getRandomValues,
      'crypto.getRandomValues is unavailable — this tool will not fabricate randomness.');
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  }

  /* ---- encodings ---- */
  function b64urlEncode(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(str) {
    var s = String(str).trim().replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var raw = atob(s), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function hex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }
  function utf8(str) { return new TextEncoder().encode(str); }
  function fromUtf8(bytes) { return new TextDecoder().decode(bytes); }
  function concat(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }

  /* Crockford-style base32 without padding, for human-transcribable secrets */
  var B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function base32(bytes) {
    var bits = 0, value = 0, out = '';
    for (var i = 0; i < bytes.length; i++) {
      value = (value << 8) | bytes[i]; bits += 8;
      while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
  }

  /* ---- MD5, needed only for the legacy EmerDPO OTP chain sha256(md5(secret+salt)) ---- */
  function md5hex(input) {
    var msg = typeof input === 'string' ? utf8(input) : input;
    var S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
    var K = new Array(64);
    for (var i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    var len = msg.length;
    var withOne = len + 1;
    var padded = new Uint8Array((((withOne + 8 + 63) / 64) | 0) * 64);
    padded.set(msg, 0); padded[len] = 0x80;
    var bitLenLo = (len << 3) >>> 0, bitLenHi = Math.floor(len / 536870912) >>> 0;
    var dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, bitLenLo, true);
    dv.setUint32(padded.length - 4, bitLenHi, true);
    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    function rotl(x, c) { return ((x << c) | (x >>> (32 - c))) >>> 0; }
    for (var off = 0; off < padded.length; off += 64) {
      var M = new Array(16);
      for (var j = 0; j < 16; j++) M[j] = dv.getUint32(off + j * 4, true);
      var A = a0, B = b0, C = c0, D = d0;
      for (var k = 0; k < 64; k++) {
        var F, g;
        if (k < 16) { F = (B & C) | (~B & D); g = k; }
        else if (k < 32) { F = (D & B) | (~D & C); g = (5 * k + 1) % 16; }
        else if (k < 48) { F = B ^ C ^ D; g = (3 * k + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * k) % 16; }
        F = (F + A + K[k] + M[g]) >>> 0;
        A = D; D = C; C = B;
        B = (B + rotl(F, S[k])) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    var out = new Uint8Array(16), odv = new DataView(out.buffer);
    odv.setUint32(0, a0, true); odv.setUint32(4, b0, true);
    odv.setUint32(8, c0, true); odv.setUint32(12, d0, true);
    return hex(out);
  }

  /* ---- WebCrypto ---- */
  function subtle() {
    need(typeof crypto !== 'undefined' && crypto.subtle,
      'crypto.subtle is unavailable in this context. Open the file directly in Chromium or Firefox; this tool refuses to substitute weaker cryptography.');
    return crypto.subtle;
  }
  async function sha256hex(input) {
    var data = typeof input === 'string' ? utf8(input) : input;
    var d = await subtle().digest('SHA-256', data);
    return hex(new Uint8Array(d));
  }
  async function hkdf(keyMaterial, salt, info, lengthBytes) {
    var base = await subtle().importKey('raw', keyMaterial, 'HKDF', false, ['deriveBits']);
    var bits = await subtle().deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: salt, info: utf8(info) }, base, lengthBytes * 8);
    return new Uint8Array(bits);
  }
  async function aesKey(raw, usages) {
    return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, usages);
  }
  async function seal(keyBytes, nonce, plaintext, aad) {
    var key = await aesKey(keyBytes, ['encrypt']);
    var ct = await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      key, plaintext);
    return new Uint8Array(ct);
  }
  async function open(keyBytes, nonce, ciphertext, aad) {
    var key = await aesKey(keyBytes, ['decrypt']);
    var pt = await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      key, ciphertext);
    return new Uint8Array(pt);
  }

  /* ---- wormhole-style triple: NNN-evenword-oddword ----
     Derived from key material, never generated independently. It is a pairing
     fingerprint spoken aloud, not a secret: it carries no entropy of its own. */
  async function tripleFrom(keyMaterial, salt) {
    var d = await hkdf(keyMaterial, salt, 'ness-wormhole-1/triple', 4);
    var channel = ((d[0] << 8) | d[1]) % 1000;
    return channel + '-' + PGP_EVEN[d[2]] + '-' + PGP_ODD[d[3]];
  }
  /* Same shape, derived from an arbitrary string (used for DPO secrets). */
  async function tripleFromString(str) {
    var d = await hkdf(utf8(str), utf8('ness-wormhole-1'), 'ness-wormhole-1/triple', 4);
    var channel = ((d[0] << 8) | d[1]) % 1000;
    return channel + '-' + PGP_EVEN[d[2]] + '-' + PGP_ODD[d[3]];
  }

  return {
    randomBytes: randomBytes, b64urlEncode: b64urlEncode, b64urlDecode: b64urlDecode,
    hex: hex, utf8: utf8, fromUtf8: fromUtf8, concat: concat, base32: base32,
    md5hex: md5hex, sha256hex: sha256hex, hkdf: hkdf, seal: seal, open: open,
    tripleFrom: tripleFrom, tripleFromString: tripleFromString,
    PGP_EVEN: PGP_EVEN, PGP_ODD: PGP_ODD
  };
})();
