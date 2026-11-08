/*
 * Halftone Arrange for Adobe Illustrator
 *
 * 選択中のオブジェクト（スキャンした筆跡のベクタなど）を、カラーハーフトーン（網点）のようにグリッド配置します。
 *
 *  並べ方（最初に選ぶ。選んだ方の設定パネルに切り替わる）
 *    グラデーション : 線形 / 円形に 大 → 小（反転可）
 *    ランダム       : 大小をランダムに散らす
 *  色は扱いません（配置だけを行います。色付けは別のツールや手作業で行ってください）
 *
 *  共通の設定
 *    複製       : 1個だけ選ぶか「複製して並べる」をオンにすると、選んだものを混ぜながら指定の個数まで複製
 *                 90° 単位の回転・左右反転で 1つの元から 8 通りの形を作れる。元は残し、複製は右隣にグループで作る
 *    配置の形   : 正方形 / 横長 / 縦長（比率） / 円 / 列数で指定。ベクターなので大きさは自動（後で拡大縮小する）
 *    グリッド   : ピッチ（自動 = 最大 / 平均 / 最小サイズ × 倍率 ＋ 隙間、または mm 指定）、千鳥配置、
 *                 スクリーン角度（Y 0° / C 15° / K 45° / M 75°）、オブジェクトも角度に回転
 *    サイズ     : 自動拡大縮小（位置でサイズを付け直す。元の面積の偏りに依存しない）
 *                 濃度 大・小 = マスの面積に対するインクの面積 %。面積で比例（網点）/ 幅で比例
 *                 重ならないよう制限（バウンディングボックス基準。不定形なので「許容 %」だけ重なりを許す）
 *    形の扱い   : 同じ形を散らす / 単純な形（アンカー N 個以下: 小さい側へ・使わない・削除）/ 面積の基準
 *    ばらつき   : 位置の揺らぎ、回転のばらつき。シード固定（再抽選ボタンで変更）
 *
 *  プレビュー対応。前回の設定を記憶します
 *
 *  コードの構成
 *    1. 設定の初期値        2. メインの流れ          3. 並べる対象（通常 / 複製）と元に戻す処理
 *    4. 配置（手順ごとの関数） 5. 幾何（グリッド・重なり・近傍）  6. 計測（範囲・面積・アンカー）
 *    7. 小物（乱数など）     8. 設定の保存            9. ダイアログ
 */

#target illustrator

(function () {
    var SETTINGS_FILE = new File(Folder.userData + "/halftone_arrange_settings.txt");
    var MM = 72 / 25.4;

    // ============================================================
    // 1. 設定の初期値
    // ============================================================

    var DEFAULTS = {
        // 並べ方
        mode: "gradient",      // "gradient" | "random"
        // グラデーション
        gradShape: "linear",   // "linear" | "radial"
        gradAngle: 0,          // 線形の向き（0° = 左が始点）
        largeFirst: true,      // 始点・中心を大きく
        // 複製
        dup: false,            // 1個だけ選んだときは常にオン
        dupCount: 300,
        dupVariety: true,      // 90° 単位の回転・左右反転をランダムに
        // 配置の形
        region: "square",      // "square" | "landscape" | "portrait" | "circle" | "cols"
        ratio: 1.5,            // 横長・縦長の比（長辺 ÷ 短辺）
        colsAuto: true, cols: 10,
        // グリッド
        pitchAuto: true,
        pitchBasis: "avg",     // "max" | "avg" | "min"
        pitchScale: 100,       // %
        gap: 1,                // mm
        pitchX: 10, pitchY: 10, // mm
        stagger: false,
        gridAngle: 45,
        rotateObjects: false,
        // サイズ
        autoScale: true,
        sizeMax: 100,          // マスの面積に対する %
        sizeMin: 5,
        sizeCurve: "area",     // "area"（面積で比例＝網点） | "linear"（幅で比例）
        noOverlap: true,
        overlapTol: 20,        // %
        scaleStroke: true,
        useVisible: true,
        // 形の扱い
        mixShapes: true,
        simpleMode: "small",   // "none" | "small" | "exclude" | "delete"
        simpleAnchors: 5,
        areaBasis: "path",     // "path" | "bounds"
        // ばらつき
        jitter: 0,             // ピッチに対する %
        rotJitter: 0,          // ±°
        seed: 1,
        preview: false
    };

    // ============================================================
    // 2. メインの流れ
    // ============================================================

    if (app.documents.length === 0) {
        alert("ドキュメントを開いてください。");
        return;
    }

    var doc = app.activeDocument;
    var sel = doc.selection;

    if (!sel || sel.typename === "TextRange" || sel.length < 1) {
        alert("選択ツールでオブジェクトを選択してから実行してください。");
        return;
    }

    // 選択したオブジェクト（複製モードでは複製の元）と、その範囲
    var sources = [];
    var union = null;
    for (var i = 0; i < sel.length; i++) {
        sources.push(sel[i]);
        var b = getBounds(sel[i], true);
        union = union ? unionBounds(union, b) : b;
    }
    var single = sources.length === 1; // 1個だけなら複製モード固定
    var layoutCenter = centerOf(union);

    // 並べる対象の状態（3. で管理）
    var items, itemSigs;                 // 並べるオブジェクトと、散らす単位の指紋（複製時のみ）
    var origCenters, scales, rotations;  // 元の位置と、掛けた拡大率・回転角（元に戻す用）
    var hiddenByPreview = [];            // 削除予定でプレビュー中だけ隠したもの
    var measureCache, anchorCache;       // 計測結果（arrange は必ず元の状態で呼ぶので使い回せる）
    var scaleStroke = true;
    var moved = false;
    var dupGroup = null, dupKey = null;  // 複製をまとめたグループと、その作り方
    setItems(sources, null);

    var opt = showDialog(loadSettings());
    if (moved) restore();
    if (!opt) {
        prepareItems(null);
        app.redraw();
        return;
    }
    saveSettings(opt);

    prepareItems(opt);
    var excluded = arrange(opt);
    if (dupGroup) doc.selection = [dupGroup];
    reportExcluded(excluded, opt);

    function reportExcluded(list, o) {
        if (list.length === 0) return;
        if (o.simpleMode === "delete") {
            for (var k = 0; k < list.length; k++) list[k].remove();
            alert("単純な形 " + list.length + " 個を削除しました（取り消しで戻せます）。");
        } else {
            // 使わなかった単純な形を選択状態にして、削除や移動をしやすくする
            doc.selection = list;
            alert("単純な形 " + list.length + " 個は配置に使わず、元の位置に残しました（選択中）。");
        }
    }

    // ============================================================
    // 3. 並べる対象（通常 / 複製）と元に戻す処理
    // ============================================================

    function setItems(list, sigs) {
        items = list;
        itemSigs = sigs;
        origCenters = [];
        scales = [];
        rotations = [];
        for (var k = 0; k < items.length; k++) {
            origCenters.push(centerOf(getBounds(items[k], true)));
            scales.push(1);
            rotations.push(0);
        }
        measureCache = {};
        anchorCache = null;
        moved = false;
    }

    function isDup(o) {
        return o !== null && (single || o.dup);
    }

    // 複製モードなら複製を用意する（個数・シード・回転反転が同じなら作り直さない）。
    // o が null か通常モードなら複製を消して、選択したものに戻す。呼ぶ前に restore() しておくこと
    function prepareItems(o) {
        var key = isDup(o) ? [Math.round(o.dupCount), o.seed, o.dupVariety].join("/") : null;
        if (key === dupKey) return;
        if (dupGroup) {
            dupGroup.remove();
            dupGroup = null;
        }
        dupKey = key;
        if (key === null) {
            setItems(sources, null);
            return;
        }

        var count = Math.max(1, Math.round(o.dupCount));
        var rand = makeRng(o.seed * 7919 + 1); // 配置の乱数とは別の系列
        dupGroup = sources[0].parent.groupItems.add();
        dupGroup.move(sources[0], ElementPlacement.PLACEBEFORE);
        dupGroup.name = "ハーフトーン整列";
        var copies = [], sigs = [];
        for (var k = 0; k < count; k++) {
            var si = k % sources.length; // 元を均等に使う（並びは配置で混ぜる）
            var c = sources[si].duplicate(dupGroup, ElementPlacement.PLACEATEND);
            var v = 0;
            if (o.dupVariety) {
                // 90° 単位の回転と左右反転で、1つの元から 8 通りの形を作る
                v = Math.floor(rand() * 8);
                if (v % 4) c.rotate(90 * (v % 4), true, true, true, true, Transformation.CENTER);
                if (v >= 4) c.resize(-100, 100, true, true, true, true, 100, Transformation.CENTER);
            }
            copies.push(c);
            // 隣り合わせたくない単位: 元が複数なら同じ元、1つだけなら同じ向き
            sigs.push(sources.length > 1 ? "src" + si : "v" + v);
        }
        setItems(copies, sigs);
    }

    function restore() {
        for (var h = 0; h < hiddenByPreview.length; h++) hiddenByPreview[h].hidden = false;
        hiddenByPreview = [];
        for (var k = 0; k < items.length; k++) {
            if (rotations[k] !== 0) {
                rotateItem(items[k], -rotations[k]);
                rotations[k] = 0;
            }
            if (Math.abs(scales[k] - 1) > 1e-9) {
                scaleItem(items[k], 1 / scales[k]);
                scales[k] = 1;
            }
            var cur = centerOf(getBounds(items[k], true));
            var dx = origCenters[k][0] - cur[0];
            var dy = origCenters[k][1] - cur[1];
            if (dx !== 0 || dy !== 0) items[k].translate(dx, dy);
        }
        moved = false;
    }

    function scaleItem(it, f) {
        var p = f * 100;
        it.resize(p, p, true, true, true, true, scaleStroke ? p : 100, Transformation.CENTER);
    }

    function rotateItem(it, deg) {
        it.rotate(deg, true, true, true, true, Transformation.CENTER);
    }

    // ============================================================
    // 4. 配置
    //    arrange は手順を順に呼ぶだけ。途中の値は ctx に入れて受け渡す
    // ============================================================

    // 戻り値: 単純な形として配置に使わなかったオブジェクト
    function arrange(o) {
        var ctx = {
            o: o,
            gradient: o.mode === "gradient",
            dup: isDup(o),
            rand: makeRng(o.seed), // シード固定（プレビューで設定を変えても揺らぎが変わらないように）
            excluded: []
        };
        ctx.auto = o.autoScale || ctx.dup; // 複製は同じ形なので、自動拡大縮小しないと網点にならない

        collectInfo(ctx);
        if (ctx.n > 0) {
            decidePitch(ctx);
            buildPoints(ctx);
            assignItems(ctx);
            applyVariation(ctx);
            decideScales(ctx);
            placeItems(ctx);
            moved = true;
        }
        return ctx.excluded;
    }

    // 4-1. 各オブジェクトのサイズ・面積を集める。単純な形の除外もここで
    function collectInfo(ctx) {
        var o = ctx.o;
        var meas = measure(o);
        var anc = o.simpleMode !== "none" ? anchors() : null;
        var info = [];
        var st = { maxW: 0, maxH: 0, minW: Infinity, minH: Infinity, sumW: 0, sumH: 0 };
        for (var k = 0; k < items.length; k++) {
            var simple = anc !== null && anc[k] <= o.simpleAnchors;
            if (simple && (o.simpleMode === "exclude" || o.simpleMode === "delete")) {
                ctx.excluded.push(items[k]);
                if (o.simpleMode === "delete" && !items[k].hidden) {
                    items[k].hidden = true;
                    hiddenByPreview.push(items[k]);
                }
                continue;
            }
            var w = meas[k].w, h = meas[k].h, a = meas[k].area;
            st.maxW = Math.max(st.maxW, w);
            st.maxH = Math.max(st.maxH, h);
            st.minW = Math.min(st.minW, w);
            st.minH = Math.min(st.minH, h);
            st.sumW += w;
            st.sumH += h;
            info.push({
                item: items[k], index: k, w: w, h: h, area: a, simple: simple,
                sig: itemSigs ? itemSigs[k] : shapeSignature(w, h, a)
            });
        }
        ctx.info = info;
        ctx.n = info.length;
        ctx.stats = st;
    }

    // 4-2. ピッチ（マスの大きさ）
    function decidePitch(ctx) {
        var o = ctx.o, st = ctx.stats, n = ctx.n;
        var px, py;
        if (o.pitchAuto) {
            // 基準サイズ（最大 / 平均 / 最小）× 倍率 ＋ 隙間
            var baseW = o.pitchBasis === "max" ? st.maxW : o.pitchBasis === "min" ? st.minW : st.sumW / n;
            var baseH = o.pitchBasis === "max" ? st.maxH : o.pitchBasis === "min" ? st.minH : st.sumH / n;
            px = baseW * o.pitchScale / 100 + o.gap * MM;
            py = baseH * o.pitchScale / 100 + o.gap * MM;
        } else {
            px = o.pitchX * MM;
            py = o.pitchY * MM;
        }
        ctx.px = px > 0 ? px : 1;
        ctx.py = py > 0 ? py : 1;
        var th = o.gridAngle * Math.PI / 180;
        ctx.ct = Math.cos(th);
        ctx.st = Math.sin(th);
    }

    // 4-3. グリッドの点を作り、使う n 個を選ぶ。
    //      グラデーションは始点側から n 個（余りは小さい側が欠けて網点が消えていく）、ランダムは余りをランダムに間引く。
    //      各点の t は 0 = 始点 … 1 = 終点
    function buildPoints(ctx) {
        var o = ctx.o, n = ctx.n, k;
        var pts;
        if (o.region === "cols") {
            pts = latticeBlock(n, ctx.px, ctx.py, o, ctx.ct, ctx.st);
        } else {
            // ピッチはオブジェクトから決め、形の大きさを点がちょうど n 個以上入るまで縮める
            var ellipse = o.region === "circle";
            var ratio = Math.max(1, o.ratio) || 1;
            var aspect = o.region === "landscape" ? ratio : o.region === "portrait" ? 1 / ratio : 1;
            var W = Math.sqrt(n * ctx.px * ctx.py * aspect / (ellipse ? Math.PI / 4 : 1));
            var H = W / aspect;
            var s = findPitchScale(n, ctx.px, ctx.py, W, H, o.stagger, ctx.ct, ctx.st, ellipse);
            // 探索と同じ条件で点を作ってから縮める（枠を 1/s にすると境界の点が落ちることがある）
            pts = latticeInRegion(ctx.px * s, ctx.py * s, W, H, o.stagger, ctx.ct, ctx.st, ellipse);
            for (k = 0; k < pts.length; k++) {
                pts[k].x /= s;
                pts[k].y /= s;
            }
        }

        var ga = o.gradAngle * Math.PI / 180;
        var gc = Math.cos(ga), gs = Math.sin(ga);
        for (k = 0; k < pts.length; k++) {
            var p = pts[k];
            if (!ctx.gradient) p.v = ctx.rand();
            else if (o.gradShape === "radial") p.v = Math.sqrt(p.x * p.x + p.y * p.y);
            else p.v = p.x * gc + p.y * gs;
        }
        pts.sort(byV);
        pts = pts.slice(0, n);

        var vMin = pts[0].v, vSpan = pts[n - 1].v - pts[0].v;
        for (k = 0; k < n; k++) pts[k].t = ctx.gradient && vSpan > 1e-6 ? (pts[k].v - vMin) / vSpan : 0;
        ctx.pts = pts;
    }

    // 4-4. どのオブジェクトをどの点に置くか（info[k] を pts[k] に置く）
    function assignItems(ctx) {
        var o = ctx.o, n = ctx.n, k;
        var info = ctx.info;

        if (!ctx.gradient || (ctx.auto && o.mixShapes)) {
            // 自動拡大縮小ではサイズを位置で決め直すので、元の面積順に並べる必要はない。
            // 面積順のままだと同じ形（＝同じ面積）が固まるので、ランダムに割り当てる
            shuffle(info, ctx.rand);
        } else {
            info.sort(function (p, q) {
                var d = o.largeFirst ? q.area - p.area : p.area - q.area;
                return d !== 0 ? d : p.index - q.index;
            });
        }

        // 単純な形は小さい側へ（小さく刷られれば形の粗さが目立たない）
        var simpleToSmall = o.simpleMode === "small";
        if (simpleToSmall && ctx.gradient) {
            var rich = [], plain = [];
            for (k = 0; k < n; k++) (info[k].simple ? plain : rich).push(info[k]);
            // pts は始点側から並んでいる。始点が大なら単純な形は後ろ、始点が小なら前
            info = o.largeFirst ? rich.concat(plain) : plain.concat(rich);
        }

        // 同じ形が隣り合わないように入れ替える。
        // 自動拡大縮小なしのグラデーションは、面積の並びを崩さないよう近い順位の中でだけ入れ替える
        if (o.mixShapes) {
            var win = ctx.auto || !ctx.gradient ? n : Math.max(3, Math.round(n * 0.05));
            var nb = neighborLists(ctx.pts, 1.05 * Math.sqrt(ctx.px * ctx.px + ctx.py * ctx.py));
            spreadShapes(nb, info, win, ctx.rand, simpleToSmall && ctx.gradient);
        }

        // ランダムの大小（0 = 大 … 1 = 小）。単純な形を小さい側へ寄せるときは小さめに
        if (!ctx.gradient) {
            for (k = 0; k < n; k++) {
                info[k].rt = simpleToSmall && info[k].simple ? 0.6 + 0.4 * ctx.rand() : ctx.rand();
            }
        }
        ctx.info = info;
    }

    // 4-5. 回転のばらつき・位置の揺らぎと、重なり判定用の実効サイズ
    //      （回転後のバウンディングボックス × 重なり許容。不定形は箱より中身が小さいので少し重ねてよい）
    function applyVariation(ctx) {
        var o = ctx.o, n = ctx.n, k;
        var tol = 1 - Math.min(Math.max(o.overlapTol, 0), 90) / 100;
        for (k = 0; k < n; k++) {
            var inf = ctx.info[k];
            inf.phi = o.rotJitter ? (ctx.rand() * 2 - 1) * o.rotJitter : 0;
            var ext = rotatedExtent(inf.w, inf.h, inf.phi);
            inf.ew = ext[0] * tol;
            inf.eh = ext[1] * tol;
        }
        if (o.jitter) {
            // グラデーションの値は揺らす前の格子で決めてある
            var jx = o.jitter / 100 * ctx.px, jy = o.jitter / 100 * ctx.py;
            for (k = 0; k < n; k++) {
                ctx.pts[k].x += (ctx.rand() * 2 - 1) * jx;
                ctx.pts[k].y += (ctx.rand() * 2 - 1) * jy;
            }
        }
    }

    // 4-6. 各オブジェクトの拡大率。
    //      自動拡大縮小: 位置で濃度を決め、目標面積 = マスの面積 × 濃度 から逆算する
    function decideScales(ctx) {
        var o = ctx.o, n = ctx.n, info = ctx.info, pts = ctx.pts, k;
        var cell = ctx.px * ctx.py;
        var cMax = Math.max(0, o.sizeMax) / 100, cMin = Math.max(0, o.sizeMin) / 100;

        function limitOf(inf) {
            return overlapLimit(inf.ew, inf.eh, ctx.px, ctx.py, o, ctx.ct, ctx.st);
        }

        if (ctx.auto && o.noOverlap && cMax > 0) {
            // 形によって重ならずに置ける最大の濃度が違う。一番きつい形に合わせると
            // 細長い形が1つあるだけで全体が薄くなるので、中央値に合わせて濃度の範囲全体を縮める
            // （それより窮屈な形は、下で個別に縮める）
            var caps = [];
            for (k = 0; k < n; k++) {
                var lim = limitOf(info[k]);
                caps.push(lim * lim * info[k].area / cell);
            }
            caps.sort(function (p, q) { return p - q; });
            var covCap = caps[Math.floor((n - 1) / 2)];
            if (covCap < cMax) {
                cMin *= covCap / cMax;
                cMax = covCap;
            }
        }

        var fs = [];
        for (k = 0; k < n; k++) {
            var f = 1;
            if (ctx.auto) {
                var t; // 0 = 大 … 1 = 小
                if (!ctx.gradient) t = info[k].rt;
                else t = o.largeFirst ? pts[k].t : 1 - pts[k].t;
                var cov = o.sizeCurve === "area"
                    ? cMax + t * (cMin - cMax)
                    : Math.pow(Math.sqrt(cMax) + t * (Math.sqrt(cMin) - Math.sqrt(cMax)), 2);
                f = Math.sqrt(cell * cov / info[k].area);
            }
            if (o.noOverlap) f = Math.min(f, limitOf(info[k]));
            if (!(f > 0) || !isFinite(f)) f = 1e-3;
            fs.push(f);
        }
        // 大きさの違うもの同士が隣り合う部分は、実際に重なっている組だけ縮める
        if (o.noOverlap) resolveOverlaps(pts, info, fs, ctx.px, ctx.py, o, ctx.ct, ctx.st);
        ctx.fs = fs;
    }

    // 4-7. 拡大縮小・回転・移動を実際に行う
    function placeItems(ctx) {
        var o = ctx.o, n = ctx.n, info = ctx.info, pts = ctx.pts, fs = ctx.fs, k;
        var gridRot = o.rotateObjects ? o.gridAngle : 0;

        // 配置後の全体の範囲（オブジェクトの大きさ込み）
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (k = 0; k < n; k++) {
            var e = rotatedExtent(info[k].w * fs[k], info[k].h * fs[k], gridRot + info[k].phi);
            minX = Math.min(minX, pts[k].x - e[0] / 2);
            maxX = Math.max(maxX, pts[k].x + e[0] / 2);
            minY = Math.min(minY, pts[k].y - e[1] / 2);
            maxY = Math.max(maxY, pts[k].y + e[1] / 2);
        }
        var midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;

        // 置く場所: 通常は元の選択範囲の中心。複製は元に重ならないよう右隣に置く
        var cx0 = layoutCenter[0], cy0 = layoutCenter[1];
        if (ctx.dup) cx0 = union[2] + 10 * MM + (maxX - minX) / 2;

        scaleStroke = o.scaleStroke;
        for (k = 0; k < n; k++) {
            var it = info[k].item, idx = info[k].index;
            if (Math.abs(fs[k] - 1) > 1e-9) {
                scaleItem(it, fs[k]);
                scales[idx] *= fs[k];
            }
            var rot = gridRot + info[k].phi;
            if (rot !== 0) {
                rotateItem(it, rot);
                rotations[idx] += rot;
            }
            var cur = centerOf(getBounds(it, true));
            var dx = cx0 + pts[k].x - midX - cur[0];
            var dy = cy0 + pts[k].y - midY - cur[1];
            if (dx !== 0 || dy !== 0) it.translate(dx, dy);
        }
    }

    // 計測（元の状態で呼ばれるので、同じ条件なら結果を使い回す）
    function measure(o) {
        var key = (o.useVisible ? "v" : "g") + o.areaBasis;
        if (measureCache[key]) return measureCache[key];
        var list = [];
        for (var k = 0; k < items.length; k++) {
            var bb = getBounds(items[k], o.useVisible);
            var w = bb[2] - bb[0], h = bb[1] - bb[3];
            var a = o.areaBasis === "bounds" ? w * h : itemArea(items[k]);
            if (!(a > 0)) a = w * h;
            list.push({ w: w, h: h, area: a });
        }
        return (measureCache[key] = list);
    }

    function anchors() {
        if (anchorCache) return anchorCache;
        anchorCache = [];
        for (var k = 0; k < items.length; k++) anchorCache.push(anchorCount(items[k]));
        return anchorCache;
    }

    // ============================================================
    // 5. 幾何（グリッド・重なり・近傍）
    // ============================================================

    // 列×行のブロック状のグリッド（配置の形「列数で指定」）
    function latticeBlock(n, px, py, o, ct, st) {
        var radial = o.mode === "gradient" && o.gradShape === "radial";
        var cols, rows;
        if (o.colsAuto) {
            if (radial) {
                // 円が収まるよう広めに作ってから中心に近い点を使う
                cols = Math.ceil(Math.sqrt(n * 4 / Math.PI)) + 2;
                rows = Math.ceil(cols * px / py);
            } else {
                cols = Math.max(1, Math.round(Math.sqrt(n * py / px)));
                rows = Math.ceil(n / cols);
            }
        } else {
            cols = Math.max(1, Math.round(o.cols));
            rows = Math.ceil(n / cols);
            if (radial) rows = Math.max(rows, Math.ceil(cols * px / py));
        }
        if (cols * rows < n) rows = Math.ceil(n / cols);

        var x0 = (cols - 1) * px / 2 + (o.stagger && rows > 1 ? px / 4 : 0);
        var y0 = (rows - 1) * py / 2;
        var pts = [];
        for (var r = 0; r < rows; r++) {
            for (var c = 0; c < cols; c++) {
                var lx = c * px + (o.stagger && r % 2 === 1 ? px / 2 : 0) - x0;
                var ly = y0 - r * py; // 上の行から
                pts.push({ x: lx * ct - ly * st, y: lx * st + ly * ct, order: r * cols + c });
            }
        }
        return pts;
    }

    // 幅 W × 高さ H の枠（ellipse なら楕円。中心が原点）に入るグリッドの点
    function latticeInRegion(px, py, W, H, stagger, ct, st, ellipse) {
        var R = Math.sqrt(W * W + H * H) / 2;
        var cm = Math.ceil(R / px) + 1, rm = Math.ceil(R / py) + 1;
        var hw = W / 2 + 1e-6, hh = H / 2 + 1e-6;
        var pts = [];
        for (var r = -rm; r <= rm; r++) {
            for (var c = -cm; c <= cm; c++) {
                var lx = c * px + (stagger && r % 2 !== 0 ? px / 2 : 0);
                var ly = -r * py;
                var x = lx * ct - ly * st;
                var y = lx * st + ly * ct;
                var inside = ellipse
                    ? (x * x) / (hw * hw) + (y * y) / (hh * hh) <= 1
                    : Math.abs(x) <= hw && Math.abs(y) <= hh;
                if (inside) pts.push({ x: x, y: y, order: (r + rm) * (2 * cm + 1) + (c + cm) });
            }
        }
        return pts;
    }

    // 枠に n 個以上の点が入る、できるだけ大きいピッチ倍率を探す
    // （ピッチを s 倍するのと、枠を 1/s 倍するのは同じこと）
    function findPitchScale(n, px, py, W, H, stagger, ct, st, ellipse) {
        function count(s) {
            return latticeInRegion(px * s, py * s, W, H, stagger, ct, st, ellipse).length;
        }
        var s0 = Math.sqrt(W * H / (n * px * py));
        var lo = s0, hi = s0, guard = 0;
        while (count(lo) < n && guard++ < 60) lo /= 1.5;
        guard = 0;
        while (count(hi) >= n && guard++ < 60) hi *= 1.5;
        for (var k = 0; k < 30; k++) {
            var mid = (lo + hi) / 2;
            if (count(mid) >= n) lo = mid;
            else hi = mid;
        }
        return lo;
    }

    // 各点から距離 R 以内の点の一覧（空間ハッシュで近いものだけ調べる）
    function neighborLists(pts, R) {
        var n = pts.length, k, cells = {}, nb = [];
        for (k = 0; k < n; k++) {
            var key = Math.floor(pts[k].x / R) + "," + Math.floor(pts[k].y / R);
            (cells[key] = cells[key] || []).push(k);
            nb.push([]);
        }
        for (k = 0; k < n; k++) {
            var cx = Math.floor(pts[k].x / R), cy = Math.floor(pts[k].y / R);
            for (var ix = -1; ix <= 1; ix++) {
                for (var iy = -1; iy <= 1; iy++) {
                    var list = cells[(cx + ix) + "," + (cy + iy)];
                    if (!list) continue;
                    for (var m = 0; m < list.length; m++) {
                        var j = list[m];
                        if (j === k) continue;
                        var dx = pts[j].x - pts[k].x, dy = pts[j].y - pts[k].y;
                        if (dx * dx + dy * dy <= R * R) nb[k].push(j);
                    }
                }
            }
        }
        return nb;
    }

    // 近くのマスに同じ形があれば、別のマスのオブジェクトと入れ替えて散らす。
    // info は点の並び順（始点側から）なので、window の範囲内の相手とだけ入れ替える。
    // keepClass: 単純な形とそれ以外をまたいで入れ替えない（単純な形を小さい側に寄せたとき）
    function spreadShapes(nb, info, window, rand, keepClass) {
        var n = info.length, k;
        function clash(i) {
            var c = 0, s = info[i].sig, l = nb[i];
            for (var q = 0; q < l.length; q++) if (info[l[q]].sig === s) c++;
            return c;
        }
        function swap(a, b) {
            var t = info[a]; info[a] = info[b]; info[b] = t;
        }
        for (var pass = 0; pass < 8; pass++) {
            var improved = false;
            for (k = 0; k < n; k++) {
                if (clash(k) === 0) continue;
                for (var tries = 0; tries < 12; tries++) {
                    var j = k + Math.round((rand() * 2 - 1) * window);
                    if (j < 0 || j >= n || j === k) continue;
                    if (info[j].sig === info[k].sig) continue;
                    if (keepClass && info[j].simple !== info[k].simple) continue;
                    var before = clash(k) + clash(j);
                    swap(k, j);
                    if (clash(k) + clash(j) < before) {
                        improved = true;
                        break;
                    }
                    swap(k, j);
                }
            }
            if (!improved) break;
        }
    }

    // 隣のマスの同じ大きさのオブジェクトとバウンディングボックスが重ならない最大の拡大率
    // 2つの箱が重ならない条件: 中心の差 |dx| ≥ 幅 または |dy| ≥ 高さ
    function overlapLimit(w, h, px, py, o, ct, st) {
        var vecs = [[px, 0], [0, py], [px, py], [px, -py]];
        if (o.stagger) {
            vecs.push([px / 2, py]);
            vecs.push([px / 2, -py]);
        }
        var limit = Infinity;
        for (var k = 0; k < vecs.length; k++) {
            var dx = vecs[k][0], dy = vecs[k][1];
            if (!o.rotateObjects) {
                // オブジェクトは回転しないので、回転後のグリッドのベクトルで判定
                var rx = dx * ct - dy * st, ry = dx * st + dy * ct;
                dx = rx;
                dy = ry;
            }
            var fx = w > 0 ? Math.abs(dx) / w : Infinity;
            var fy = h > 0 ? Math.abs(dy) / h : Infinity;
            limit = Math.min(limit, Math.max(fx, fy));
        }
        return limit;
    }

    // 近くの組のバウンディングボックスが重なっていたら、2つとも同じ比率で接するまで縮める
    function resolveOverlaps(pts, info, fs, px, py, o, ct, st) {
        var n = pts.length, k;
        var D = 2.3 * Math.max(px, py);
        var local = [];
        for (k = 0; k < n; k++) {
            // オブジェクトも回転させるときはグリッドの座標系で判定
            local.push(o.rotateObjects
                ? { x: pts[k].x * ct + pts[k].y * st, y: -pts[k].x * st + pts[k].y * ct }
                : { x: pts[k].x, y: pts[k].y });
        }
        var nb = neighborLists(local, D);
        var pairs = [];
        for (k = 0; k < n; k++) {
            for (var m = 0; m < nb[k].length; m++) {
                var j = nb[k][m];
                if (j > k) pairs.push([k, j, Math.abs(local[j].x - local[k].x), Math.abs(local[j].y - local[k].y)]);
            }
        }
        for (var pass = 0; pass < 30; pass++) {
            var changed = false;
            for (m = 0; m < pairs.length; m++) {
                var p = pairs[m], a = p[0], b = p[1];
                var sw = (info[a].ew * fs[a] + info[b].ew * fs[b]) / 2;
                var sh = (info[a].eh * fs[a] + info[b].eh * fs[b]) / 2;
                var g = Math.max(sw > 0 ? p[2] / sw : Infinity, sh > 0 ? p[3] / sh : Infinity);
                if (g < 1 - 1e-9) {
                    fs[a] *= g;
                    fs[b] *= g;
                    changed = true;
                }
            }
            if (!changed) break;
        }
    }

    // w × h の箱を deg 回転させたときの外接箱の幅・高さ
    function rotatedExtent(w, h, deg) {
        var r = deg * Math.PI / 180;
        var c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
        return [w * c + h * s, w * s + h * c];
    }

    // 形の見分け用の簡易な指紋（縦横比と、箱に対するインクの割合）。
    // 同じ元データのコピーは大きさが違っても（90° 回したものも）同じ指紋になる
    function shapeSignature(w, h, area) {
        if (!(w > 0) || !(h > 0)) return "0";
        return Math.round(Math.abs(Math.log(w / h)) * 8) + ":" + Math.round(area / (w * h) * 12);
    }

    // ============================================================
    // 6. 計測（範囲・面積・アンカー）
    // ============================================================

    // クリップグループはクリッピングパスの範囲を使う
    function getBounds(it, visible) {
        if (it.typename === "GroupItem" && it.clipped) {
            var clip = findClipPath(it);
            if (clip) return clip.geometricBounds;
        }
        return visible ? it.visibleBounds : it.geometricBounds;
    }

    function findClipPath(g) {
        for (var k = 0; k < g.pageItems.length; k++) {
            var p = g.pageItems[k];
            if (p.typename === "PathItem" && p.clipping) return p;
            if (p.typename === "CompoundPathItem" && p.pathItems.length > 0 && p.pathItems[0].clipping) return p;
        }
        return null;
    }

    // インクの面積: 塗りの面積 ＋ 線の長さ × 線幅（開いたパスや線だけのものも数えるため）
    function itemArea(it) {
        var a = 0, k;
        switch (it.typename) {
            case "PathItem":
                if (it.filled) a = Math.abs(it.area);
                if (it.stroked) a += it.length * it.strokeWidth * (it.filled && it.closed ? 0.5 : 1);
                return a;
            case "CompoundPathItem":
                for (k = 0; k < it.pathItems.length; k++) a += it.pathItems[k].area;
                a = Math.abs(a);
                if (it.pathItems.length > 0 && it.pathItems[0].stroked) {
                    var len = 0;
                    for (k = 0; k < it.pathItems.length; k++) len += it.pathItems[k].length;
                    a += len * it.pathItems[0].strokeWidth * 0.5;
                }
                return a;
            case "GroupItem":
                if (it.clipped) {
                    var clip = findClipPath(it);
                    if (clip) return itemArea(clip);
                }
                for (k = 0; k < it.pageItems.length; k++) a += itemArea(it.pageItems[k]);
                return a;
            default:
                var bb = it.geometricBounds;
                return (bb[2] - bb[0]) * (bb[1] - bb[3]);
        }
    }

    // アンカーポイントの数（グループ・複合パスは合計）。形の複雑さの目安
    function anchorCount(it) {
        var c = 0, k;
        switch (it.typename) {
            case "PathItem":
                return it.pathPoints.length;
            case "CompoundPathItem":
                for (k = 0; k < it.pathItems.length; k++) c += it.pathItems[k].pathPoints.length;
                return c;
            case "GroupItem":
                for (k = 0; k < it.pageItems.length; k++) c += anchorCount(it.pageItems[k]);
                return c;
            default:
                return 9999; // 画像・テキストなどは単純な形として扱わない
        }
    }

    function centerOf(bb) {
        return [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
    }

    function unionBounds(p, q) {
        return [Math.min(p[0], q[0]), Math.max(p[1], q[1]), Math.max(p[2], q[2]), Math.min(p[3], q[3])];
    }

    // ============================================================
    // 7. 小物
    // ============================================================

    function byV(p, q) {
        var d = p.v - q.v;
        if (Math.abs(d) > 1e-6) return d;
        return p.order - q.order;
    }

    function shuffle(arr, rand) {
        for (var k = arr.length - 1; k > 0; k--) {
            var j = Math.floor(rand() * (k + 1));
            var t = arr[k]; arr[k] = arr[j]; arr[j] = t;
        }
    }

    // シード付き乱数（mulberry32）
    function makeRng(seed) {
        var a = (Math.round(seed) || 1) >>> 0;
        return function () {
            a = (a + 0x6D2B79F5) >>> 0;
            var t = a;
            t = mul32(t ^ (t >>> 15), t | 1);
            t ^= t + mul32(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // 32bit 整数の乗算（ExtendScript には Math.imul が無い）
    function mul32(a, b) {
        var ah = (a >>> 16) & 0xffff, al = a & 0xffff;
        var bh = (b >>> 16) & 0xffff, bl = b & 0xffff;
        return (al * bl + (((ah * bl + al * bh) << 16) >>> 0)) | 0;
    }

    function num(text, fallback) {
        var v = parseFloat(String(text).replace(/[０-９．－]/g, function (ch) {
            return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
        }));
        return isNaN(v) ? fallback : v;
    }

    function indexOf(arr, v) {
        for (var k = 0; k < arr.length; k++) if (arr[k] === v) return k;
        return -1;
    }

    // ============================================================
    // 8. 設定の保存
    // ============================================================

    function loadSettings() {
        var s = {};
        for (var k in DEFAULTS) s[k] = DEFAULTS[k];
        try {
            if (SETTINGS_FILE.exists) {
                SETTINGS_FILE.encoding = "UTF-8";
                SETTINGS_FILE.open("r");
                var saved = eval(SETTINGS_FILE.read());
                SETTINGS_FILE.close();
                for (var key in saved) {
                    if (DEFAULTS.hasOwnProperty(key)) s[key] = saved[key];
                }
            }
        } catch (e) {}
        return s;
    }

    function saveSettings(s) {
        try {
            SETTINGS_FILE.encoding = "UTF-8";
            SETTINGS_FILE.open("w");
            SETTINGS_FILE.write(s.toSource());
            SETTINGS_FILE.close();
        } catch (e) {}
    }

    // ============================================================
    // 9. ダイアログ
    //     パネルごとに build〜 関数で作る。部品は ui に登録し、readUI でまとめて読む。
    //     変更の監視は部品を作る関数（check / field / list / radio）が watched に登録しておき、最後にまとめて結ぶ
    // ============================================================

    function showDialog(s) {
        var ui = {};
        var watched = [];

        // --- 部品 ---
        function panel(parent, title) {
            var p = parent.add("panel", undefined, title);
            p.orientation = "column";
            p.alignChildren = "left";
            return p;
        }
        function row(parent) {
            var g = parent.add("group");
            g.orientation = "row";
            g.alignChildren = "center";
            return g;
        }
        function text(parent, str) {
            return parent.add("statictext", undefined, str);
        }
        function check(parent, str, value) {
            var c = parent.add("checkbox", undefined, str);
            c.value = !!value;
            watched.push([c, "onClick"]);
            return c;
        }
        function radio(parent, str, value) {
            var r = parent.add("radiobutton", undefined, str);
            r.value = !!value;
            watched.push([r, "onClick"]);
            return r;
        }
        function field(parent, value, chars) {
            var e = parent.add("edittext", undefined, String(value));
            e.characters = chars || 4;
            watched.push([e, "onChange"]);
            return e;
        }
        // labels と values を対にしたドロップダウン。値は listValue() で読む
        function list(parent, labels, values, value) {
            var d = parent.add("dropdownlist", undefined, labels);
            d.values = values;
            d.selection = Math.max(0, indexOf(values, value));
            watched.push([d, "onChange"]);
            return d;
        }
        function listValue(d) {
            return d.values[d.selection.index];
        }
        // --- ウィンドウ ---
        var w = new Window("dialog", "ハーフトーン整列");
        w.orientation = "column";
        w.alignChildren = "fill";

        var gMode = row(w);
        text(gMode, "並べ方:");
        ui.rbGrad = radio(gMode, "グラデーション", s.mode === "gradient");
        ui.rbRand = radio(gMode, "ランダム", s.mode !== "gradient");

        var gCols2 = row(w);
        gCols2.alignChildren = "top";
        var colL = gCols2.add("group");
        colL.orientation = "column";
        colL.alignChildren = "fill";
        var colR = gCols2.add("group");
        colR.orientation = "column";
        colR.alignChildren = "fill";

        buildDupPanel(colL);
        buildShapePanel(colL);
        buildGridPanel(colL);
        buildJitterPanel(colL);

        // 並べ方ごとのパネルは同じ場所に重ね、選んだ方だけ表示する
        var stack = colR.add("group");
        stack.orientation = "stack";
        stack.alignChildren = ["fill", "top"];
        ui.pGrad = buildGradientPanel(stack);
        ui.pRand = buildRandomPanel(stack);

        buildSizePanel(colR);
        buildFormPanel(colR);

        var gBtn = row(w);
        gBtn.alignment = "fill";
        ui.cbPreview = check(gBtn, "プレビュー", s.preview);
        var gSpacer = gBtn.add("group");
        gSpacer.alignment = ["fill", "center"];
        gBtn.add("button", undefined, "キャンセル", { name: "cancel" });
        gBtn.add("button", undefined, "OK", { name: "ok" });

        // --- パネル ---
        function buildDupPanel(parent) {
            var p = panel(parent, "複製");
            var g = row(p);
            ui.cbDup = check(g, "複製して並べる　個数:", single || s.dup);
            ui.cbDup.enabled = !single; // 1個だけ選んだときは常に複製
            ui.cbDup.helpTip = "選んだオブジェクトを混ぜながら指定の個数まで複製します。元はそのまま残り、複製は右隣にグループで作られます";
            ui.etDupCount = field(g, s.dupCount, 5);
            ui.cbDupVariety = check(p, "回転・反転をランダムに（1つの元から8通り）", s.dupVariety);
        }

        function buildShapePanel(parent) {
            var p = panel(parent, "配置の形");
            var g = row(p);
            ui.ddRegion = list(g, ["正方形", "横長", "縦長", "円", "列数で指定"],
                ["square", "landscape", "portrait", "circle", "cols"], s.region);
            ui.gRatio = row(g);
            text(ui.gRatio, "比率:");
            ui.etRatio = field(ui.gRatio, s.ratio, 4);
            text(ui.gRatio, "（1.5 = 3:2）");
            ui.gColsRow = row(p);
            text(ui.gColsRow, "列数:");
            ui.cbColsAuto = check(ui.gColsRow, "自動", s.colsAuto);
            ui.etCols = field(ui.gColsRow, s.cols, 5);
            text(p, "大きさは自動（仕上がりは後で拡大縮小）");
        }

        function buildGridPanel(parent) {
            var p = panel(parent, "グリッド");
            ui.cbPitchAuto = check(p, "ピッチ自動", s.pitchAuto);
            ui.gPitchBase = row(p);
            text(ui.gPitchBase, "基準:");
            ui.ddPitchBasis = list(ui.gPitchBase, ["最大サイズ", "平均サイズ", "最小サイズ"], ["max", "avg", "min"], s.pitchBasis);
            text(ui.gPitchBase, "×");
            ui.etPitchScale = field(ui.gPitchBase, s.pitchScale, 4);
            text(ui.gPitchBase, "% ＋隙間:");
            ui.etGap = field(ui.gPitchBase, s.gap, 4);
            text(ui.gPitchBase, "mm");
            ui.gPitch = row(p);
            text(ui.gPitch, "ピッチ 横:");
            ui.etPX = field(ui.gPitch, s.pitchX, 5);
            text(ui.gPitch, "縦:");
            ui.etPY = field(ui.gPitch, s.pitchY, 5);
            text(ui.gPitch, "mm");
            ui.cbStagger = check(p, "千鳥配置（奇数行を半ピッチずらす）", s.stagger);
            var g = row(p);
            text(g, "スクリーン角度:");
            ui.etGridAngle = field(g, s.gridAngle, 5);
            text(g, "°");
            var presets = g.add("dropdownlist", undefined, ["プリセット", "Y 0°", "C 15°", "K 45°", "M 75°"]);
            presets.selection = 0;
            presets.onChange = function () {
                var a = [null, 0, 15, 45, 75][presets.selection.index];
                if (a === null) return;
                ui.etGridAngle.text = String(a);
                presets.selection = 0;
                refresh();
            };
            ui.cbRotateObj = check(p, "オブジェクトもスクリーン角度に回転", s.rotateObjects);
        }

        function buildJitterPanel(parent) {
            var p = panel(parent, "ばらつき");
            var g = row(p);
            text(g, "位置:");
            ui.etJitter = field(g, s.jitter, 4);
            text(g, "%（ピッチ比）  回転: ±");
            ui.etRotJitter = field(g, s.rotJitter, 4);
            text(g, "°");
            var g2 = row(p);
            text(g2, "シード:");
            ui.etSeed = field(g2, s.seed, 6);
            var bt = g2.add("button", undefined, "再抽選");
            bt.onClick = function () {
                ui.etSeed.text = String(Math.floor(Math.random() * 99999) + 1);
                refresh();
            };
        }

        function buildGradientPanel(parent) {
            var p = panel(parent, "グラデーション");
            var g = row(p);
            text(g, "形:");
            ui.ddGradShape = list(g, ["線形", "円形"], ["linear", "radial"], s.gradShape);
            ui.gGradAngle = row(g);
            text(ui.gGradAngle, "方向:");
            ui.etGradAngle = field(ui.gGradAngle, s.gradAngle, 4);
            text(ui.gGradAngle, "°（0° = 左が始点）");
            var g2 = row(p);
            ui.rbLarge = radio(g2, "始点・中心を大きく", s.largeFirst);
            ui.rbSmall = radio(g2, "始点・中心を小さく", !s.largeFirst);
            return p;
        }

        function buildRandomPanel(parent) {
            var p = panel(parent, "ランダム");
            text(p, "大小と形をランダムに散らします");
            return p;
        }

        function buildSizePanel(parent) {
            var p = panel(parent, "サイズ");
            ui.cbAutoScale = check(p, "位置に合わせて自動で拡大縮小", s.autoScale);
            ui.cbAutoScale.helpTip = "位置でサイズを付け直します。元の面積の偏りに依存しません";
            ui.gSize = row(p);
            text(ui.gSize, "濃度 大:");
            ui.etSizeMax = field(ui.gSize, s.sizeMax, 4);
            text(ui.gSize, "% 小:");
            ui.etSizeMin = field(ui.gSize, s.sizeMin, 4);
            text(ui.gSize, "%（マス面積比）");
            ui.gCurve = row(p);
            text(ui.gCurve, "変化:");
            ui.ddCurve = list(ui.gCurve, ["面積で比例（網点）", "幅で比例"], ["area", "linear"], s.sizeCurve);
            var g = row(p);
            ui.cbNoOverlap = check(g, "重ならないよう制限　許容:", s.noOverlap);
            ui.etOverlapTol = field(g, s.overlapTol, 4);
            text(g, "%");
            ui.cbScaleStroke = check(p, "線幅も拡大縮小", s.scaleStroke);
            ui.cbVisible = check(p, "サイズの計算に線幅を含める", s.useVisible);
        }

        function buildFormPanel(parent) {
            var p = panel(parent, "形の扱い");
            ui.cbMix = check(p, "同じ形を散らす", s.mixShapes);
            ui.cbMix.helpTip = "隣のマスに同じ形が来ないように入れ替えます";
            var g = row(p);
            text(g, "単純な形（アンカー");
            ui.etSimpleAnchors = field(g, s.simpleAnchors, 3);
            text(g, "個以下）:");
            ui.ddSimple = list(g, ["そのまま", "小さい側へ", "使わない", "削除"],
                ["none", "small", "exclude", "delete"], s.simpleMode);
            g.helpTip = "スキャンの解像度不足で四角などに潰れた跡を見分けます。\n" +
                "小さい側へ: 網点の小さい側に回して粗さを目立たなくする\n" +
                "使わない: 配置せず元の位置に残し、終了後に選択状態にする\n" +
                "削除: 配置せずに削除する（プレビュー中は非表示。取り消しで戻せます）";
            var g2 = row(p);
            text(g2, "面積の基準:");
            ui.ddArea = list(g2, ["インクの面積", "バウンディングボックス"], ["path", "bounds"], s.areaBasis);
        }

        // --- 読み取り・表示の切り替え ---
        function readUI() {
            return {
                mode: ui.rbGrad.value ? "gradient" : "random",
                gradShape: listValue(ui.ddGradShape),
                gradAngle: num(ui.etGradAngle.text, s.gradAngle),
                largeFirst: ui.rbLarge.value,
                dup: ui.cbDup.value,
                dupCount: Math.max(1, Math.round(num(ui.etDupCount.text, s.dupCount))),
                dupVariety: ui.cbDupVariety.value,
                region: listValue(ui.ddRegion),
                ratio: num(ui.etRatio.text, s.ratio),
                colsAuto: ui.cbColsAuto.value,
                cols: num(ui.etCols.text, s.cols),
                pitchAuto: ui.cbPitchAuto.value,
                pitchBasis: listValue(ui.ddPitchBasis),
                pitchScale: num(ui.etPitchScale.text, s.pitchScale),
                gap: num(ui.etGap.text, s.gap),
                pitchX: num(ui.etPX.text, s.pitchX),
                pitchY: num(ui.etPY.text, s.pitchY),
                stagger: ui.cbStagger.value,
                gridAngle: num(ui.etGridAngle.text, s.gridAngle),
                rotateObjects: ui.cbRotateObj.value,
                autoScale: ui.cbAutoScale.value,
                sizeMax: num(ui.etSizeMax.text, s.sizeMax),
                sizeMin: num(ui.etSizeMin.text, s.sizeMin),
                sizeCurve: listValue(ui.ddCurve),
                noOverlap: ui.cbNoOverlap.value,
                overlapTol: num(ui.etOverlapTol.text, s.overlapTol),
                scaleStroke: ui.cbScaleStroke.value,
                useVisible: ui.cbVisible.value,
                mixShapes: ui.cbMix.value,
                simpleMode: listValue(ui.ddSimple),
                simpleAnchors: num(ui.etSimpleAnchors.text, s.simpleAnchors),
                areaBasis: listValue(ui.ddArea),
                jitter: num(ui.etJitter.text, s.jitter),
                rotJitter: num(ui.etRotJitter.text, s.rotJitter),
                seed: num(ui.etSeed.text, s.seed),
                preview: ui.cbPreview.value
            };
        }

        function updateEnabled() {
            // 並べ方ごとのパネル
            ui.pGrad.visible = ui.rbGrad.value;
            ui.pRand.visible = !ui.rbGrad.value;
            ui.gGradAngle.enabled = listValue(ui.ddGradShape) === "linear";
            // 複製（同じ形なので自動拡大縮小は常にオン）
            var dupOn = single || ui.cbDup.value;
            ui.etDupCount.enabled = dupOn;
            ui.cbDupVariety.enabled = dupOn;
            ui.cbAutoScale.enabled = !dupOn;
            var autoOn = ui.cbAutoScale.value || dupOn;
            ui.gSize.enabled = autoOn;
            ui.gCurve.enabled = autoOn;
            // 配置の形・グリッド
            var region = listValue(ui.ddRegion);
            ui.gRatio.enabled = region === "landscape" || region === "portrait";
            ui.gColsRow.enabled = region === "cols";
            ui.etCols.enabled = !ui.cbColsAuto.value;
            ui.gPitchBase.enabled = ui.cbPitchAuto.value;
            ui.gPitch.enabled = !ui.cbPitchAuto.value;
            ui.etOverlapTol.enabled = ui.cbNoOverlap.value;
        }

        function refresh() {
            updateEnabled();
            if (moved) restore();
            if (ui.cbPreview.value) {
                var o = readUI();
                prepareItems(o);
                arrange(o);
            } else {
                prepareItems(null); // プレビューを切ったら複製も消す
            }
            app.redraw();
        }

        for (var k = 0; k < watched.length; k++) watched[k][0][watched[k][1]] = refresh;

        updateEnabled();
        w.onShow = function () { if (ui.cbPreview.value) refresh(); };

        if (w.show() !== 1) return null;
        return readUI();
    }
})();
