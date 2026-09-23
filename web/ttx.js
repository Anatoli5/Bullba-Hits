// The characteristics panel's arithmetic (23.09, outputs/ttx-panel-spec-2026-09-22.md section 3.2): the numbers
// the garage shows for a vehicle, worked out the way the client itself works them out in
// gui/shared/items_parameters/params.py (VehicleParams) - formulas and bytecode lines in
// outputs/ttx-formulas-2026-09-22.md, facts in docs/KNOWLEDGE.md section 17. Pure functions and no DOM: the page
// (web/app.js) hands in what it already has and paints what comes back, and a node harness runs the same code.
//
// NOTHING THE PAGE ALREADY COMPUTES IS COMPUTED HERE AGAIN. The reload and the magazine rule come from
// ArmorBallistics.reloadSeconds, an autoloader's slots from ArmorBallistics.autoreloadScaled, the crew factors from
// the page's crewFactors() (handed in as `crew`), the configuration's effects from the page's aimEffects() (handed
// in as `fx`, decomposed the way the garage orders them: devices first, rounded, then the perks - their deviations
// summed, params __calcParamWithSkillFactorAmp 1472). The battle's modifiers are already inside a live aim block,
// and the heat of an Ares gun is a state of the battle, not a characteristic, so neither is applied here.
//
// Input of values():
//   ttx    the vehicle's characteristics file (data/ttx/<id>.js, section 2.1 of the spec), or null
//   pair   one of ttx.configs - a turret and a gun - or null
//   aim    the aim block the fire figures are taken from: the pair's own bare block for the stock, the emulator's
//          own (aimBlockData) for the build of the gun that fired, the pair's block otherwise (spec 1.3-1.4)
//   shells the shells of the pair's gun; shell - the one the DPM is counted with (the page's own when it is one of
//          this gun's, else the first: the garage's active shell by default)
//   fx     {dev, devAdd, perk, perkAdd, weight, devices}: products of the devices, directive and consumables per
//          page input, their sums, the perks' summed deviations and sums, the mass of the fitted devices in kg and
//          the catalogue rows of the fitted devices; absent = nothing fitted
//   crew   crewFactors(): the factor of every role and `camouflage`, the Concealment factor
//
// Units are the client's (radians, m/s, W, kg); what is shown is the garage's (degrees, km/h, hp, t, %).
(function (root) {
  'use strict';
  var DEG = 180 / Math.PI, KMH = 3.6, HP_W = 735.5, KMH_TO_MS = 0.27778;   // component_constants.KMH_TO_MS
  // --- The client's own rounding (math_common.pyc, backport_system_locale.pyc; ttx-formulas section 9) ---------
  // decimal_round(x, n) = Decimal(repr(x)).quantize(10^-n, ROUND_HALF_UP). JavaScript's String(x) is the same
  // shortest round-trip form Python 2.7's repr gives, so the half is decided on that decimal string - not on
  // x * 10^n, which would move the float first. The exponent form of a very small or large number is expanded.
  function dr(x, n) {
    x = Number(x); n = n || 0;
    if (!isFinite(x)) return x;
    var neg = x < 0, s = String(Math.abs(x));
    var m = /^(\d+)(?:\.(\d*))?(?:e([+-]\d+))?$/.exec(s);
    if (!m) return x;
    var digits = m[1] + (m[2] || ''), point = m[1].length + (m[3] ? Number(m[3]) : 0);
    while (point < 1) { digits = '0' + digits; point++; }
    while (digits.length < point) digits += '0';
    var whole = digits.slice(0, point), frac = digits.slice(point);
    if (frac.length <= n) return neg ? -Number(whole + '.' + frac) : Number(whole + '.' + frac);
    var kept = (whole + frac.slice(0, n)).split('');
    if (frac.charAt(n) >= '5') {
      var i = kept.length - 1;
      while (i >= 0) { if (kept[i] === '9') { kept[i] = '0'; i--; } else { kept[i] = String(Number(kept[i]) + 1); break; } }
      if (i < 0) kept.unshift('1');
    }
    var str = kept.join(''), cut = str.length - n;
    var out = Number(n ? str.slice(0, cut) + '.' + str.slice(cut) : str);
    return neg ? -out : out;
  }
  // round_py2_style: Python 2's round, a half away from zero.
  function rp(x) { x = Number(x); return x < 0 ? -Math.round(-x) : Math.round(x); }
  // getNiceNumberFormat: two decimals at most, trailing zeros dropped. The client's own rounding of the last digit
  // is native (wulf.getRealFormat) and not visible in the bytecode; decimal_round is the documented guess
  // (spec risk 1). No thousands separator: the client's depends on the locale.
  function nice(x) {
    if (x === null || x === undefined || !isFinite(Number(x))) return '—';
    var v = dr(Number(x), 2);
    return String(v === 0 ? 0 : v);
  }
  // getIntegralFormat(int(v)): TRUNCATED, not rounded (hit points, engine power).
  function integral(x) { return x === null || x === undefined || !isFinite(Number(x)) ? '—' : String(Math.trunc(Number(x))); }
  // math_common.ceilTo(num, decimals): ceil(decimal_round((num + 0.0004) / 10^decimals, 1)) * 10^decimals.
  function ceilTo(x, decimals) { var k = Math.pow(10, decimals); return Math.ceil(dr((x + 0.0004) / k, 1)) * k; }

  // --- What kind of loading the gun has (the order of params __calcReloadTime 1383-1394) -----------------------
  function tagsOf(a) { var t = {}; (Array.isArray(a && a.gunTags) ? a.gunTags : []).forEach(function (x) { t[String(x)] = true; }); return t; }
  function loading(a) {
    if (!a) return '';
    var t = tagsOf(a);
    if (t.autoreload || a.autoreload) return 'autoreload';
    if (t.dualGun || a.dualGun) return 'dualGun';
    if (t.twinGun || a.twinGun) return 'twinGun';
    if ((t.unlimitedClip || a.unlimitedClip) && a.overheatGun && a.temperatureGun) return 'overheat';
    if (t.autoShoot || a.autoShoot) return 'autoShoot';
    if (a.clip && a.clip[0] > 1) return 'clip';
    if (a.burst && a.burst[0] > 1) return 'burst';
    return 'single';
  }
  // items_parameters.getShotsPerMinute 134: rounds a minute for a reload of T seconds.
  function shotsPerMinute(a, T, autoreload) {
    var mech = Array.isArray(a.gunMechanics) ? a.gunMechanics : [];
    var burst = mech.indexOf('chargeableBurst') >= 0 ? 1 : (a.burst && a.burst[0] > 1 ? Number(a.burst[0]) : 1);
    var burstGap = a.burst && a.burst.length > 1 ? Number(a.burst[1]) || 0 : 0;
    var clip = Array.isArray(a.clip) && a.clip.length > 1 ? [Number(a.clip[0]) || 1, Number(a.clip[1]) || 0] : [1, 0];
    var n, t = T;
    if (autoreload) { n = 1; t = Math.max(T, clip[1]); } else n = clip[0] > 1 ? clip[0] / burst : 1;
    var span = t + (burst - 1) * burstGap * n + (n - 1) * clip[1];
    return span > 0 ? burst * n * 60 / span : null;
  }
  // params_utils.getTemperatureRateOfFire 47-66 (checked 23.09): an Ares gun fires until it overheats, cools and
  // goes again; rounds a minute over that whole cycle.
  function overheatRate(a) {
    var t = a.temperatureGun || {}, o = a.overheatGun || {}, clip = a.clip || [1, 0];
    var maxT = Number(t.maxTemperature), per = Number(t.heatingPerShot), cool = Number(t.coolingPerSec);
    var slow = Number(o.coolingPerSecFactor) > 0 ? Number(o.coolingPerSecFactor) : 1, delay = Number(t.coolingDelay) || 0;
    if (!(maxT > 0 && per > 0 && cool > 0 && clip[1] > 0)) return null;
    var clipRate = rp(60 / clip[1]), burst = maxT * 60 / (per * clipRate), cooling = maxT / (cool * slow);
    var cycles = 60 / (burst + delay + cooling);
    return {spm: cycles * maxT / per, shots: rp(maxT / per), burst: burst, cooling: cooling, delay: delay};
  }

  var NO_FX = {dev: {}, devAdd: {}, perk: {}, perkAdd: {}, weight: 0, devices: []};
  // The stock crew of the garage: 100 % and no skills - 1.043 on every role the commander does not hold himself,
  // 1.0 on his own, Concealment 0.57. The page always hands its own crewFactors() in; this is the harness's.
  var STOCK_CREW = {commander: 1, gunner: 1.043, driver: 1.043, radioman: 1.043, loader: 1.043, camouflage: 0.57};
  function num(v) { v = Number(v); return v !== null && v !== '' && isFinite(v) ? v : null; }
  // The last figure of a device's value list - [plain, in its own category's slot], or one number. The mod writes a
  // client LevelsFactor as {values: [...], op} (spec section 8 point 6); a bare list or number is taken too.
  function last(v) {
    if (v && !Array.isArray(v) && typeof v === 'object') v = v.values;
    return Array.isArray(v) ? num(v[v.length - 1]) : num(v);
  }
  // The vehicle's own figure for a device the client sets per vehicle (type.optDevsOverrides: the camouflage net
  // and the exhaust), looked up by the entry itself, by the entry without its Class band (the client keys the
  // standard ones by family) and by the catalogue's own key - or null.
  function overrideOf(ttx, dev, input) {
    var table = ttx && ttx.vehicle && ttx.vehicle.optDevsOverrides;
    if (!table || !dev) return null;
    var keys = [dev.id, String(dev.id).replace(/_tier\d+$/, ''), dev.override && dev.override[input]];
    for (var i = 0; i < keys.length; i++) {
      var row = keys[i] && table[keys[i]];
      if (!row) continue;
      var v = last(row.invisibilityBonus !== undefined ? row.invisibilityBonus : row);   // {factor: {values}} as the mod writes it
      if (v !== null) return v;
    }
    return null;
  }
  function catalogueAdd(dev, input) { var e = dev && dev.eff && dev.eff[input]; return e && e[0] === 'add' ? last(e.slice(1)) || 0 : 0; }

  function values(input) {
    input = input || {};
    var t = input.ttx || null, pair = input.pair || null, a = input.aim || (pair && pair.aim) || null;
    var fx = input.fx || NO_FX, crew = input.crew || STOCK_CREW, R = root.ArmorBallistics;
    var dev = fx.dev || {}, devAdd = fx.devAdd || {}, perk = fx.perk || {}, perkAdd = fx.perkAdd || {};
    function mul(k) { var v = Number(dev[k]); return v > 0 ? v : 1; }
    function add(k) { return Number(devAdd[k]) || 0; }
    function amp(k) { return 1 + (Number(perk[k]) || 0); }
    function padd(k) { return Number(perkAdd[k]) || 0; }
    function own(k) { var v = a ? Number(a[k]) : NaN; return v > 0 && isFinite(v) ? v : 1; }
    var g = crew.gunner || 1, l = crew.loader || 1, d = crew.driver || 1, c = crew.commander || 1;
    var out = {kind: loading(a), missing: {}};
    var turret = t && pair && Array.isArray(t.turrets) ? t.turrets[pair.turret] || null : null;
    var modules = (t && t.modules) || {}, modes = (t && t.vehicle && t.vehicle.modes) || {};

    // ---- Fire ----------------------------------------------------------------------------------------------
    var shell = input.shell || (input.shells && input.shells[0]) || null;
    var alpha = shell ? num(shell.alpha) : null;
    out.avgDamage = alpha > 0 ? rp(alpha) : null;
    var rl = a && R && R.reloadSeconds ? R.reloadSeconds(a, {reload: mul('reloadTimeFactor') / l}) : null;
    var spm = null, spmMin = null;
    if (rl) {
      // T in the garage's own order: the devices and the crew (inside reloadSeconds), the mechanics' extra reload,
      // then the perks - Mag Mastery only where reloadSeconds says the gun is a magazine one - and last the delay
      // of a stationary reload (params __calcReloadTime 1394-1410).
      var extra = (pair && pair.reloadExtra) || {}, perkT = (Number(perk.reloadTimeFactor) || 0) + (rl.magazine ? Number(perk.magazineReload) || 0 : 0);
      var T = (rl.reload + (Number(extra.extraReloadTime) || 0)) * (1 + perkT) + (Number(extra.mechanicsReloadDelay) || 0);
      out.reload = T;
      if (out.kind === 'autoreload') {
        var times = R.autoreloadScaled ? R.autoreloadScaled(a, rl) : null;
        if (times) {
          times = times.map(function (v) { return v * (1 + (Number(perk.reloadTimeFactor) || 0)); });
          out.autoReloadTime = times.slice().reverse();   // the garage lists them in loading order (KNOWLEDGE section 4)
          out.clipFireRate = [times.reduce(function (s, v) { return s + v; }, 0), rl.interval, rl.shots];
          spm = shotsPerMinute(a, Math.min.apply(null, times), true);
          spmMin = shotsPerMinute(a, Math.max.apply(null, times), true);
        } else out.missing.reload = 'the autoloader’s times are not in the record';
      } else if (out.kind === 'dualGun' && a.dualGun && Array.isArray(a.dualGun.reloadTimes)) {
        var k = rl.reload / a.reloadTime * (1 + (Number(perk.reloadTimeFactor) || 0));
        var dual = a.dualGun.reloadTimes.map(function (v) { return Number(v) * k; }).filter(function (v) { return v > 0; });
        if (dual.length) { out.dualGun = dual; spm = 60 / Math.min.apply(null, dual); spmMin = 60 / Math.max.apply(null, dual); out.reload = Math.min.apply(null, dual); }
      } else if (out.kind === 'twinGun') {
        var k2 = rl.reload / a.reloadTime * (1 + (Number(perk.reloadTimeFactor) || 0)), second = a.twinGun && num(a.twinGun.twinGunReloadTime);
        var twin = [a.reloadTime * k2].concat(second > 0 ? [second * k2] : []);
        out.twinGun = twin; spm = 60 / Math.min.apply(null, twin); spmMin = 60 / Math.max.apply(null, twin); out.reload = Math.min.apply(null, twin);
      } else if (out.kind === 'overheat') {
        var heat = overheatRate(a);
        if (heat) { out.overheat = heat; spm = heat.spm; }
        else out.missing.reload = 'the gun’s heat parameters are not in the record';
      } else {
        spm = shotsPerMinute(a, T, false);
        if (out.kind === 'single') out.reloadTimeSecs = spm ? 60 / spm : null;
        else out.clipFireRate = [T, rl.interval, rl.shots];
        if (out.kind === 'burst' && rl.burst) out.burst = rl.burst;
      }
    } else out.missing.reload = a ? 'the record carries no reload for this gun' : 'no aim block';
    out.shotsPerMinute = spm; out.shotsPerMinuteSlow = spmMin;
    out.avgDamagePerMinute = spm && out.avgDamage ? rp(spm * out.avgDamage) : null;
    if (a && a.dispersion > 0) {
      // Rounded to four places BEFORE Armorer (params 1172); the stabilisation terms are the client's own units
      // turned into the ones players know: per km/h and per degree a second (KNOWLEDGE section 17, AMX 50 B).
      out.shotDispersionAngle = dr(a.dispersion * own('multFactor') * mul('multFactor') / g * 100, 4) * amp('multFactor');
      var additive = own('additiveFactor') * mul('additiveFactor');
      out.stabMovement = num(a.movementFactor) !== null ? a.movementFactor * KMH_TO_MS * additive * mul('movementFactor') * amp('movementFactor') : null;
      out.stabRotation = num(a.rotationFactor) !== null ? a.rotationFactor / DEG * additive * mul('rotationFactor') * amp('rotationFactor') : null;
      out.stabTurret = num(a.turretRotationFactor) !== null ? a.turretRotationFactor / DEG * additive * mul('turretRotationFactor') * amp('turretRotationFactor') : null;
      out.stabAfterShot = num(a.afterShotFactor) !== null ? a.afterShotFactor * additive : null;
    }
    if (a && a.aimingTime > 0) out.aimingTime = a.aimingTime * own('aimingTimeFactor') * mul('aimingTimeFactor') / g * amp('aimingTimeFactor');

    // ---- Mobility ------------------------------------------------------------------------------------------
    // The client's own order, radians first and degrees(x) = x * (180 / pi) last: 25 deg x 1.043 is 26.074999... and
    // rounds to 26.07, where x * 180 / pi would give 26.075 and 26.08 (IS-7, ttx-formulas section 10).
    if (a && a.turretRotationSpeed > 0) out.turretRotationSpeed = dr(a.turretRotationSpeed * (g * mul('turretRotationSpeed')) * DEG, 2) * amp('turretRotationSpeed');
    // The garage divides the chassis's nominal turn by the mean terrain factor, which is how the driver (1/f) and
    // the grousers become a faster hull (params 231-249, 1481). A wheeled vehicle that cannot turn on the spot has
    // no such figure; the garage shows the steering lock of its wheels instead (params 251).
    var trf = 1 / d * mul('terrainResistance');
    // The garage divides by the MEAN of the three grounds' factors, sum / 3 (params 241): three equal factors do not
    // always average to the same float, and a figure on the half then prints its last digit the other way (Ares 90:
    // 45°/s x 1.043 is 46.935 in the client, 46.934999... over the single factor - acceptance 23.09).
    var avgTrf = (trf + trf + trf) / 3;
    if (modes.wheeled && !modes.onSpotRotation) {
      out.chassisRotationSpeed = null;
      out.maxSteeringLockAngle = modules.chassis ? num(modules.chassis.maxSteeringLockAngle) : null;
    } else if (a && a.hullRotationSpeed > 0) out.chassisRotationSpeed = a.hullRotationSpeed * mul('hullRotationSpeed') * DEG / avgTrf * amp('hullRotationSpeed');
    // params __speedLimits 1205-1225: the devices' km/h inside the rounding, Engineer's outside it; the
    // vehicle/maxSpeed factor is not applied by the garage.
    if (a && a.speedForward > 0) out.speedLimits = [dr(a.speedForward * KMH + add('speedForward'), 2) + padd('speedForward'),
      a.speedBackward > 0 ? dr(a.speedBackward * KMH + add('speedBackward'), 2) + padd('speedBackward') : null];
    var power = modules.engine ? num(modules.engine.power) : null;
    out.enginePower = power > 0 ? rp(power * mul('enginePower') / HP_W) : null;   // Engineer: no power figure in this client
    out.vehicleWeight = pair && pair.weight > 0 ? (Number(pair.weight) + (Number(fx.weight) || 0)) / 1000 : null;
    out.enginePowerPerTon = out.enginePower && out.vehicleWeight ? dr(out.enginePower / out.vehicleWeight, 2) : null;
    var tr = modules.chassis && Array.isArray(modules.chassis.terrainResistance) ? modules.chassis.terrainResistance.map(Number) : null;
    if (tr && tr.length === 3) {
      // Off-Road Driving as the garage counts it (params softGroundFactor 921-948): the medium ground divided by the
      // skill's factor, the soft one brought down towards that - all the way at a full skill.
      var firm = tr[0] * trf, medium = tr[1] / amp('mediumGround') * trf, soft = tr[2] * trf;
      soft -= (soft - medium) * Math.min(amp('softGround') - 1, 1);
      out.terrainResistance = [firm, medium, soft];
    }

    // ---- Survivability, gun limits ---------------------------------------------------------------------------
    // vehicles.__updateAttributes 2788-2789: with a health factor the hit points go UP to whole tens.
    if (pair && pair.maxHealth > 0) out.maxHealth = mul('healthFactor') !== 1 ? Math.trunc(ceilTo(pair.maxHealth * mul('healthFactor'), 1)) : Number(pair.maxHealth);
    var pitch = pair && pair.pitch && Array.isArray(pair.pitch.absolute) ? pair.pitch.absolute : null;
    if (pitch && pitch.length === 2) out.pitchLimits = pitch.map(function (p) { return -Number(p) * DEG; }).sort(function (x, y) { return x - y; });
    var yaw = pair && Array.isArray(pair.turretYawLimits) ? pair.turretYawLimits : null;
    if (yaw && yaw.length === 2) out.gunYawLimits = yaw.map(function (y) { return Math.abs(Number(y) * DEG); });
    out.maxAmmo = pair && pair.maxAmmo > 0 ? Number(pair.maxAmmo) : null;

    // ---- View range and concealment ----------------------------------------------------------------------
    var view = turret ? num(turret.circularVisionRadius) : null;
    if (view > 0) {
      // The optics on the move, the binoculars standing IN PLACE of the optics (Stereoscope.transformFactors
      // divides the optics out); Optical Calibration is a crew-side factor and stays either way. The commander's f,
      // Recon on it (circularVisionRadiusB), and Situational Awareness on top as the garage applies it (params 1152).
      var crewSide = c * (1 + padd('eagleEye')) * mul('visionBoost') * amp('finder');
      out.circularVisionRadiusMoving = view * mul('visionFactor') * crewSide;
      out.circularVisionRadius = view * (dev.visionStill > 0 ? mul('visionStill') : mul('visionFactor')) * crewSide;
    }
    var inv = t && t.vehicle && Array.isArray(t.vehicle.invisibility) ? t.vehicle.invisibility : null;
    if (inv && inv.length === 2) {
      // utils.getClientInvisibility 366: (XML x Concealment x the turret's factor + the paint's bonus + what the
      // devices add) x the multipliers. The exhaust adds always; the net only standing, and only by what it gives
      // over the exhaust (artefacts CamouflageNet 690: max(net, exhaust) - exhaust). Both are the vehicle's own
      // figures (optDevsOverrides) where its file has them. Exhaust Insulation is a factor of its own, +0.02.
      var camo = crew.camouflage || 0.57, towerF = turret && turret.invisibilityFactor > 0 ? Number(turret.invisibilityFactor) : 1;
      var paint = input.paint !== undefined ? input.paint : fx.paint;
      var bonus = paint && t.vehicle.camouflageBonus > 0 ? Number(t.vehicle.camouflageBonus) : 0;
      var exhaust = 0, net = 0, exhaustCat = 0, netCat = 0;
      (fx.devices || []).forEach(function (row) {
        if (row.eff && row.eff.invisibilityAdd) { var v1 = overrideOf(t, row, 'invisibilityAdd'); exhaust += v1 !== null ? v1 : catalogueAdd(row, 'invisibilityAdd'); exhaustCat += catalogueAdd(row, 'invisibilityAdd'); }
        if (row.eff && row.eff.invisibilityStill) { var v2 = overrideOf(t, row, 'invisibilityStill'); net += v2 !== null ? v2 : catalogueAdd(row, 'invisibilityStill'); netCat += catalogueAdd(row, 'invisibilityStill'); }
      });
      var other = add('invisibilityAdd') - exhaustCat + padd('invisibilityAdd');
      var moving = (Number(inv[0]) * camo * towerF + bonus + exhaust + other);
      var still = (Number(inv[1]) * camo * towerF + bonus + other + Math.max(net + (add('invisibilityStill') - netCat), exhaust));
      out.invisibilityMovingFactor = 100 * Math.max(0, moving);
      out.invisibilityStillFactor = 100 * Math.max(0, still);
      var atShot = pair ? num(pair.invisibilityFactorAtShot) : null;
      out.invisibilityAfterShot = atShot !== null ? out.invisibilityStillFactor * atShot : null;
    }

    // ---- The shells of the gun (the expanded view) -----------------------------------------------------------
    var speedFactor = t && t.vehicle && t.vehicle.projectileSpeedFactor > 0 ? Number(t.vehicle.projectileSpeedFactor) : null;
    // The penetration at 500 m is the garage's own (shell_params.piercingPowerTable): the client's distance law, the
    // one ballistics.js holds for the whole page, at 500 m - or at int(maxDistance) for a shell that flies less far.
    function penAt500(s, P) {
      var far = num(s.penetration500), d = s.maxDistance > 0 && s.maxDistance < 500 ? Math.floor(s.maxDistance) : 500;
      return P !== null && far !== null && R && R.atDistance ? R.atDistance(P, far, d) : far;
    }
    out.shells = (input.shells || []).map(function (s) {
      var A = num(s.alpha), r = s.damageRandomization >= 0 && s.damageRandomization <= 1 ? Number(s.damageRandomization) : 0.25;
      var P = num(s.penetration100), pr = s.randomization >= 0 && s.randomization <= 1 ? Number(s.randomization) : 0.25;
      var lo = P !== null ? Math.ceil(P * (1 - pr)) : null, hi = P !== null ? Math.floor(P * (1 + pr)) : null;
      return {shell: s, kind: s.kind, avgDamage: A > 0 ? rp(A) : null,
        damage: A > 0 ? [Math.ceil(A * (1 - r)), Math.floor(A * (1 + r))] : null,
        avgPiercingPower: P !== null ? rp((lo + hi) / 2) : null, piercingPower: P !== null ? [lo, hi] : null,
        pen500: penAt500(s, P), shellVelocity: s.speed > 0 && speedFactor ? Number(s.speed) / speedFactor : null,
        dpm: spm && A > 0 ? rp(spm * rp(A)) : null, selected: s === shell};
    });
    return out;
  }

  // --- Showing ---------------------------------------------------------------------------------------------
  function list(v, fmt) { return Array.isArray(v) && v.every(function (x) { return x !== null && isFinite(x); }) ? v.map(fmt || nice).join('/') : '—'; }
  // The reload in ONE figure for the compact row (spec 3.4.3): seconds of a single-shot gun, the whole magazine of a
  // clip or burst, "min-max" of an autoloader's slots, rounds a minute of an Ares gun, the faster of two barrels.
  function reloadText(v) {
    if (v.kind === 'autoreload' && v.autoReloadTime) {
      var slots = v.autoReloadTime.map(function (x) { return dr(x, 1); });
      return nice(Math.min.apply(null, slots)) + '-' + nice(Math.max.apply(null, slots));
    }
    if (v.kind === 'overheat') return nice(v.shotsPerMinute);
    if (v.kind === 'single') return nice(v.reloadTimeSecs);
    if (v.clipFireRate) return nice(v.clipFireRate[0]);
    return nice(v.reload);
  }
  function display(v) {
    v = v || {};
    var slots = v.autoReloadTime ? v.autoReloadTime.map(function (x) { return nice(dr(x, 1)); }) : null;
    return {
      avgDamagePerMinute: nice(v.avgDamagePerMinute), reload: reloadText(v), shotsPerMinute: nice(v.shotsPerMinute),
      reloadTimeSecs: nice(v.reloadTimeSecs),
      clipFireRate: v.clipFireRate ? [nice(v.clipFireRate[0]), nice(v.clipFireRate[1]), String(v.clipFireRate[2])].join('/') : '—',
      autoReloadTime: slots ? (slots.length > 5 ? reloadText(v) : slots.join('/')) : '—',
      shotDispersionAngle: nice(v.shotDispersionAngle), aimingTime: nice(v.aimingTime),
      stabMovement: nice(v.stabMovement), stabRotation: nice(v.stabRotation), stabTurret: nice(v.stabTurret),
      stabAfterShot: nice(v.stabAfterShot),
      turretRotationSpeed: nice(v.turretRotationSpeed), chassisRotationSpeed: nice(v.chassisRotationSpeed),
      maxSteeringLockAngle: nice(v.maxSteeringLockAngle), speedLimits: list(v.speedLimits),
      enginePower: integral(v.enginePower), vehicleWeight: nice(v.vehicleWeight), enginePowerPerTon: nice(v.enginePowerPerTon),
      maxHealth: integral(v.maxHealth), pitchLimits: list(v.pitchLimits), gunYawLimits: list(v.gunYawLimits),
      maxAmmo: v.maxAmmo ? String(v.maxAmmo) : '—',
      circularVisionRadius: nice(v.circularVisionRadius), circularVisionRadiusMoving: nice(v.circularVisionRadiusMoving),
      invisibilityStillFactor: nice(v.invisibilityStillFactor), invisibilityMovingFactor: nice(v.invisibilityMovingFactor),
      invisibilityAfterShot: nice(v.invisibilityAfterShot), terrainResistance: list(v.terrainResistance),
      avgDamage: nice(v.avgDamage)};
  }
  // Which way is better (spec 3.2): smaller for the reload, the dispersion, the aiming, the stabilisation terms,
  // the terrain resistance and the mass; bigger for everything else.
  var SMALLER = {reload: 1, reloadTimeSecs: 1, clipFireRate: 1, autoReloadTime: 1, dualGun: 1, shotDispersionAngle: 1, aimingTime: 1,
    stabMovement: 1, stabRotation: 1, stabTurret: 1, stabAfterShot: 1, terrainResistance: 1, vehicleWeight: 1};
  function better(key) { return SMALLER[key] ? -1 : 1; }
  // One number per key to compare the build with the stock by: the first of a pair, the reload figure itself.
  function score(v, key) {
    var x = key === 'reload' ? (v.kind === 'overheat' ? -v.shotsPerMinute : v.kind === 'autoreload' && v.autoReloadTime ? Math.min.apply(null, v.autoReloadTime) : v.reloadTimeSecs || (v.clipFireRate && v.clipFireRate[0]) || v.reload) : v[key];
    if (Array.isArray(x)) x = x[0];
    return x === null || x === undefined || !isFinite(Number(x)) ? null : Number(x);
  }
  // 'better', 'worse' or '' for the build against the stock, on the SHOWN figure: two numbers that print the same
  // are the same to the reader. A caller that has display() of both already hands them in.
  function compare(stock, build, key, shownStock, shownBuild) {
    var a = score(stock, key), b = score(build, key);
    if (a === null || b === null) return '';
    var sa = (shownStock || display(stock))[key], sb = (shownBuild || display(build))[key];
    if (sa !== undefined && sa === sb) return '';
    if (Math.abs(a - b) < 1e-9) return '';
    var sign = key === 'reload' && stock.kind === 'overheat' ? -1 : better(key);   // rounds a minute: bigger is better, scored negative
    return (b - a) * sign > 0 ? 'better' : 'worse';
  }

  // --- The pairs of a file (spec 3.1) ---------------------------------------------------------------------
  // The pair the recorded or exported gun is: by the XML names when the record has them, else by the gun's short
  // name (the top pair first, then the highest turret), else the top pair. -1 when the file has no pairs.
  function match(ttx, who) {
    var cfg = ttx && Array.isArray(ttx.configs) ? ttx.configs : [], turrets = (ttx && ttx.turrets) || [], i;
    if (!cfg.length) return -1;
    who = who || {};
    if (who.gunName) for (i = 0; i < cfg.length; i++) {
      var tn = turrets[cfg[i].turret] && turrets[cfg[i].turret].name;
      if (cfg[i].gun === who.gunName && (!who.turretName || tn === who.turretName)) return i;
    }
    var same = [];
    if (who.gun) for (i = 0; i < cfg.length; i++) if (cfg[i].gunUserString === who.gun) same.push(i);
    if (same.length === 1) return same[0];
    if (same.length > 1) {
      var top = same.filter(function (k) { return cfg[k].top; });
      if (top.length) return top[0];
      return same.sort(function (x, y) { return ((turrets[cfg[y].turret] || {}).level || 0) - ((turrets[cfg[x].turret] || {}).level || 0); })[0];
    }
    for (i = 0; i < cfg.length; i++) if (cfg[i].top) return i;
    return 0;
  }
  // A pair's own key, the way the page stores the user's choice: "turretName|gunName".
  function pairKey(ttx, i) {
    var p = ttx && ttx.configs && ttx.configs[i];
    if (!p) return '';
    return String(((ttx.turrets || [])[p.turret] || {}).name || p.turret) + '|' + String(p.gun);
  }
  function pairIndex(ttx, key) {
    var n = ttx && ttx.configs ? ttx.configs.length : 0;
    for (var i = 0; i < n; i++) if (pairKey(ttx, i) === key) return i;
    return -1;
  }
  // The pairs grouped by turret, in the file's order, for the picker.
  function groups(ttx) {
    var out = [], by = {};
    ((ttx && ttx.configs) || []).forEach(function (p, i) {
      var g = by[p.turret];
      if (!g) { g = by[p.turret] = {turret: p.turret, info: (ttx.turrets || [])[p.turret] || {}, pairs: []}; out.push(g); }
      g.pairs.push(i);
    });
    return out;
  }

  root.BullbaTtx = {values: values, display: display, better: better, compare: compare, loading: loading,
    match: match, pairKey: pairKey, pairIndex: pairIndex, groups: groups,
    dr: dr, rp: rp, nice: nice, integral: integral, ceilTo: ceilTo, shotsPerMinute: shotsPerMinute};
}(typeof window === 'undefined' ? globalThis : window));
