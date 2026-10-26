/*
 * «Главное в 4K» — плагин для Lampa
 *
 * Ряд на главной: значимые фильмы и сериалы с премьерой за выбранный период,
 * у которых уже есть 4K.
 *
 * Откуда берутся кандидаты:
 *   - TMDB: самые популярные фильмы и сериалы с премьерой за период;
 *   - TMDB: сейчас в кино, тренды недели, популярное;
 *   - лента релизов Lampa (CUB);
 *   - свежие работы A24.
 * Значимость (по TMDB):
 *   - A24 — всегда;
 *   - остальные — рейтинг от 7.0 и при этом много оценок или высокая популярность.
 * Наличие 4K:
 *   - отметка 4K в ленте релизов Lampa, или
 *   - 4K-раздача (2160p) с живыми сидами в парсере из настроек Lampa.
 * Фильтры в «Моих плагинах»: период премьеры, сортировка, скрывать ужасы.
 * Результат кэшируется на 6 часов.
 */
(function () {
    'use strict';

    if (window.anton_top4k_loaded) return;
    window.anton_top4k_loaded = true;

    var ROW_NAME = 'anton_top_4k';
    var ROW_TITLE = 'Главное в 4K';
    var CACHE_PREFIX = 'anton_top4k_cache_v5';
    var CACHE_HOURS = 6;
    var MAX_ITEMS = 30;

    var FEED_PAGES = 6;          // страниц ленты релизов Lampa
    var DISCOVER_MOVIE_PAGES = 4; // страниц «популярные фильмы за период» (по 20)
    var DISCOVER_TV_PAGES = 2;    // страниц «популярные сериалы за период»
    var EXTRA_LISTS = ['movie/now_playing', 'trending/movie/week', 'movie/popular', 'trending/tv/week'];

    var A24_COMPANY = 41077;
    var HORROR_GENRE = 27;

    // Ужасы, которые показываем несмотря на фильтр
    var HORROR_ALLOW = ['backrooms'];

    // Скрытые вручную (точное совпадение русского или оригинального названия)
    var HIDDEN_TITLES = ['мятеж', 'хитрый койот', 'мститель', 'убежище', 'гренландия 2', 'живая ярость'];

    // Значимость
    var MIN_RATING = 7.0;
    var MIN_VOTES = 300;
    var MIN_POPULARITY = 60;

    // Проверка 4K через парсер
    var MIN_4K_SEEDS = 5;
    var PARSER_CONCURRENCY = 4;

    // Настройки
    var S_PERIOD = 'anton_top4k_months';   // '6' | '12' | '24'
    var S_SORT = 'anton_top4k_sort3';      // 'date' | 'popular'
    var S_NOHORROR = 'anton_top4k_nohorror';

    function setting(name, def) {
        var v = Lampa.Storage.get(name, '');
        return v === '' ? def : v;
    }

    function periodMonths() { return parseInt(setting(S_PERIOD, '12')) || 12; }
    function sortMode() { return setting(S_SORT, 'date'); }
    function hideHorror() {
        var v = setting(S_NOHORROR, true);
        return v === true || v === 'true';
    }

    function isTv(card) { return !!(card.name || card.first_air_date) && !card.title; }

    function key(card) { return (isTv(card) ? 'tv' : 'movie') + card.id; }

    function releaseTime(card) {
        var t = Date.parse(card.release_date || card.first_air_date || '');
        return isNaN(t) ? 0 : t;
    }

    function periodStart() {
        var d = new Date();
        d.setMonth(d.getMonth() - periodMonths());
        return d;
    }

    function ymd(d) { return d.toISOString().slice(0, 10); }

    function inPeriod(card) {
        var t = releaseTime(card);
        return t && t >= periodStart().getTime() && t <= Date.now();
    }

    function norm(t) { return ((t || '') + '').toLowerCase().replace(/ё/g, 'е').trim(); }

    function isHidden(card) {
        var names = [card.title, card.name, card.original_title, card.original_name].map(norm);
        return HIDDEN_TITLES.some(function (h) { return names.indexOf(norm(h)) >= 0; });
    }

    function isHorrorBlocked(card) {
        if (!hideHorror()) return false;
        var genres = card.genre_ids || (card.genres || []).map(function (g) { return g.id; });
        if (genres.indexOf(HORROR_GENRE) === -1) return false;
        var title = norm((card.original_title || card.original_name || '') + ' ' + (card.title || card.name || ''));
        return !HORROR_ALLOW.some(function (w) { return title.indexOf(w) >= 0; });
    }

    function isSignificant(card, a24) {
        if (a24[key(card)]) return true;
        if ((card.vote_average || 0) < MIN_RATING) return false;
        return (card.vote_count || 0) >= MIN_VOTES || (card.popularity || 0) >= MIN_POPULARITY;
    }

    function feed4k(card) {
        return /4k|2160|uhd/i.test((card.release_quality || card.quality || '') + '');
    }

    // ---------- кэш ----------

    function cacheKey() {
        return CACHE_PREFIX + '_' + periodMonths() + '_' + sortMode() + '_' + (hideHorror() ? 1 : 0);
    }

    function readCache() {
        try {
            var c = Lampa.Storage.get(cacheKey(), '{}');
            if (typeof c === 'string') c = JSON.parse(c);
            if (c && c.time && Date.now() - c.time < CACHE_HOURS * 3600 * 1000 && c.results) return c.results;
        } catch (e) {}
        return null;
    }

    function writeCache(results) {
        try { Lampa.Storage.set(cacheKey(), { time: Date.now(), results: results }); } catch (e) {}
    }

    function clearCache() {
        try {
            ['6', '12', '24'].forEach(function (p) {
                ['date', 'popular'].forEach(function (s) {
                    [0, 1].forEach(function (h) {
                        Lampa.Storage.set(CACHE_PREFIX + '_' + p + '_' + s + '_' + h, {});
                    });
                });
            });
        } catch (e) {}
    }

    // ---------- загрузка кандидатов ----------

    function tmdbList(path, done) {
        var url = Lampa.TMDB.api(path + (path.indexOf('?') >= 0 ? '&' : '?') +
            'api_key=' + Lampa.TMDB.key() + '&language=ru');
        var net = new Lampa.Reguest();
        net.silent(url, function (json) { done((json && json.results) || []); }, function () { done([]); });
    }

    function parallel(tasks, done) {
        var results = [];
        var left = tasks.length;
        if (!left) return done(results);
        tasks.forEach(function (task, i) {
            task(function (r) {
                results[i] = r || [];
                if (--left === 0) done(results);
            });
        });
    }

    function loadCandidates(done) {
        var from = ymd(periodStart());
        var to = ymd(new Date());
        var tasks = [];

        // A24
        var a24Tasks = ['movie', 'tv'].map(function (type) {
            return function (cb) {
                tmdbList('discover/' + type + '?with_companies=' + A24_COMPANY +
                    '&sort_by=' + (type === 'movie' ? 'primary_release_date' : 'first_air_date') + '.desc', cb);
            };
        });

        // Популярное за период
        for (var p = 1; p <= DISCOVER_MOVIE_PAGES; p++) (function (page) {
            tasks.push(function (cb) {
                tmdbList('discover/movie?sort_by=popularity.desc&vote_count.gte=100' +
                    '&primary_release_date.gte=' + from + '&primary_release_date.lte=' + to + '&page=' + page, cb);
            });
        })(p);

        for (var t = 1; t <= DISCOVER_TV_PAGES; t++) (function (page) {
            tasks.push(function (cb) {
                tmdbList('discover/tv?sort_by=popularity.desc&vote_count.gte=100' +
                    '&first_air_date.gte=' + from + '&first_air_date.lte=' + to + '&page=' + page, cb);
            });
        })(t);

        EXTRA_LISTS.forEach(function (path) {
            tasks.push(function (cb) { tmdbList(path, cb); });
        });

        // Лента релизов Lampa
        if (Lampa.Api && typeof Lampa.Api.relise === 'function') {
            for (var f = 1; f <= FEED_PAGES; f++) (function (page) {
                tasks.push(function (cb) {
                    try {
                        Lampa.Api.relise({ page: page }, function (data) {
                            cb((data && data.results) || []);
                        }, function () { cb([]); });
                    } catch (e) { cb([]); }
                });
            })(f);
        }

        parallel(a24Tasks, function (a24Lists) {
            var a24 = {};
            var a24Cards = [];
            a24Lists.forEach(function (list, i) {
                list.forEach(function (c) {
                    if (i === 1) c.name = c.name || c.title; // сериалы
                    a24[key(c)] = true;
                    a24Cards.push(c);
                });
            });

            parallel(tasks, function (lists) {
                var all = a24Cards.slice();
                lists.forEach(function (list) { all = all.concat(list); });
                done(all, a24);
            });
        });
    }

    // ---------- проверка 4K через парсер ----------

    function jackettBase() {
        var url = ((Lampa.Storage.field('jackett_url') || '') + '').replace('jacred.xyz', 'jac.red').trim().replace(/\/+$/, '');
        if (!url) return '';
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        return url;
    }

    function has4kTorrent(card, done) {
        var base = jackettBase();
        if (!base) return done(false);

        var tv = isTv(card);
        var title = tv ? card.name : card.title;
        var original = tv ? card.original_name : card.original_title;
        var year = ((card.release_date || card.first_air_date || '0000') + '').slice(0, 4);

        var u = base + '/api/v2.0/indexers/all/results?apikey=' + encodeURIComponent(Lampa.Storage.field('jackett_key') || '') +
            '&Query=' + encodeURIComponent(title || original || '') +
            '&title=' + encodeURIComponent(title || '') +
            '&title_original=' + encodeURIComponent(original || '') +
            '&year=' + year +
            '&is_serial=' + (tv ? 2 : 1) +
            '&Category[]=' + (tv ? 5000 : 2000);

        var xhr = new XMLHttpRequest();
        xhr.open('GET', u, true);
        xhr.timeout = 15000;
        xhr.onload = function () {
            var found = false;
            try {
                found = (JSON.parse(xhr.responseText).Results || []).some(function (r) {
                    return /2160p|\b4k\b|uhd/i.test(r.Title || '') && (r.Seeders || 0) >= MIN_4K_SEEDS;
                });
            } catch (e) {}
            done(found);
        };
        xhr.onerror = xhr.ontimeout = function () { done(false); };
        xhr.send();
    }

    function check4k(cards, done) {
        var confirmed = [];
        var queue = cards.slice();
        var running = 0;

        if (!queue.length) return done(confirmed);

        function next() {
            if (!queue.length && running === 0) return done(confirmed);
            while (running < PARSER_CONCURRENCY && queue.length) {
                (function (card) {
                    running++;
                    var finish = function (ok) {
                        if (ok) confirmed.push(card);
                        running--;
                        next();
                    };
                    if (feed4k(card)) finish(true);
                    else has4kTorrent(card, finish);
                })(queue.shift());
            }
        }

        next();
    }

    // ---------- сборка ----------

    var lastStats = null;

    function build(done, force) {
        var cached = force ? null : readCache();
        if (cached) return done(cached);

        loadCandidates(function (all, a24) {
            // склеиваем дубли: отметка 4K из ленты переносится на карточку
            var byKey = {};
            all.forEach(function (c) {
                if (!c || !c.id) return;
                var k = key(c);
                if (!byKey[k]) byKey[k] = Object.assign({}, c);
                else if (feed4k(c)) byKey[k].release_quality = c.release_quality;
            });
            var unique = Object.keys(byKey).map(function (k) { return byKey[k]; });

            var recent = unique.filter(inPeriod);
            var clean = recent.filter(function (c) { return !isHidden(c) && !isHorrorBlocked(c); });
            var significant = clean.filter(function (c) { return isSignificant(c, a24); });

            check4k(significant, function (results) {
                results.forEach(function (c) {
                    c.source = 'tmdb';
                    if (!feed4k(c)) c.release_quality = '4K';
                });

                if (sortMode() === 'popular') {
                    results.sort(function (a, b) {
                        return ((b.popularity || 0) + (a24[key(b)] ? 50 : 0)) - ((a.popularity || 0) + (a24[key(a)] ? 50 : 0));
                    });
                } else {
                    results.sort(function (a, b) { return releaseTime(b) - releaseTime(a); });
                }

                results = results.slice(0, MAX_ITEMS);

                lastStats = {
                    candidates: unique.length,
                    recent: recent.length,
                    significant: significant.length,
                    uhd: results.length,
                    titles: results.slice(0, 8).map(function (c) { return c.title || c.name; })
                };

                if (results.length) writeCache(results);
                done(results);
            });
        });
    }

    // ---------- интерфейс ----------

    function supported() {
        return !!Lampa.ContentRows;
    }

    function diagnose() {
        if (!supported()) {
            return Lampa.Noty.show('Главное в 4K: эта версия Lampa не поддерживает ряды на главной');
        }
        Lampa.Noty.show('Главное в 4K: собираю список, это может занять до минуты…');
        build(function (results) {
            var st = lastStats || {};
            Lampa.Noty.show('Кандидатов: ' + (st.candidates || 0) +
                ', премьера за ' + periodMonths() + ' мес.: ' + (st.recent || 0) +
                ', значимых: ' + (st.significant || 0) +
                ', с 4K: ' + results.length +
                (st.titles && st.titles.length ? '. ' + st.titles.join(', ') : ''));
        }, true);
    }

    function addSettings() {
        if (!Lampa.SettingsApi) return;
        try {
            Lampa.SettingsApi.addParam({
                component: 'anton_plugins',
                param: { name: S_PERIOD, type: 'select', values: { '6': '6 месяцев', '12': '12 месяцев', '24': '2 года' }, 'default': '12' },
                field: { name: 'Главное в 4K: премьера за период' },
                onChange: clearCache
            });
            Lampa.SettingsApi.addParam({
                component: 'anton_plugins',
                param: { name: S_SORT, type: 'select', values: { 'date': 'Сначала новые', 'popular': 'Сначала популярные' }, 'default': 'date' },
                field: { name: 'Главное в 4K: сортировка' },
                onChange: clearCache
            });
            Lampa.SettingsApi.addParam({
                component: 'anton_plugins',
                param: { name: S_NOHORROR, type: 'trigger', 'default': true },
                field: { name: 'Главное в 4K: скрывать ужасы', description: 'Кроме исключений (Backrooms)' },
                onChange: clearCache
            });
            Lampa.SettingsApi.addParam({
                component: 'anton_plugins',
                param: { name: 'anton_top4k_diag', type: 'button' },
                field: {
                    name: 'Главное в 4K: обновить и показать статистику',
                    description: 'Сбрасывает кэш и показывает, что попало в ряд'
                },
                onChange: diagnose
            });
        } catch (e) {}
    }

    // Плагин загружается после того, как главная уже построена — перестраиваем её один раз
    function refreshMainIfOpen() {
        try {
            var active = Lampa.Activity.active();
            if (active && active.component === 'main') {
                var params = Object.assign({}, active);
                delete params.activity;
                Lampa.Activity.replace(params);
            }
        } catch (e) {}
    }

    var building = false;

    function buildInBackground() {
        if (building) return;
        building = true;
        build(function (results) {
            building = false;
            if (results.length) refreshMainIfOpen();
        });
    }

    function init() {
        addSettings();

        if (!supported()) {
            console.log('Главное в 4K: эта версия Lampa не поддерживает ряды на главной');
            return;
        }

        Lampa.ContentRows.add({
            name: ROW_NAME,
            title: ROW_TITLE,
            index: 1,
            screen: ['main'],
            call: function () {
                return function (call) {
                    var cached = readCache();
                    if (cached && cached.length) {
                        return call({
                            title: ROW_TITLE,
                            results: cached.map(function (c) { return Object.assign({}, c); })
                        });
                    }
                    // Списка ещё нет: не задерживаем главную, собираем в фоне
                    call();
                    buildInBackground();
                };
            }
        });

        refreshMainIfOpen();
    }

    if (window.appready) init();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') init();
        });
    }
})();
