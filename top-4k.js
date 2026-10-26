/*
 * «Главное в 4K» — плагин для Lampa
 *
 * Ряд на главной странице: только значимые новинки, которые уже вышли в 4K.
 * Источник новинок и качества — лента релизов Lampa (CUB, поле release_quality).
 * Значимость — по данным TMDB:
 *   - фильмы и сериалы A24 — всегда;
 *   - блокбастеры: очень много оценок или очень высокая популярность;
 *   - резонансные: высокий рейтинг при большом числе оценок.
 * Фильтры (в «Моих плагинах»):
 *   - лента релизов за ~последний квартал; премьера не старше 1–3 лет;
 *   - сортировка: по свежести выхода в 4K, по дате премьеры или по популярности;
 *   - скрывать ужасы (кроме списка исключений).
 * Результат кэшируется на 6 часов.
 */
(function () {
    'use strict';

    if (window.anton_top4k_loaded) return;
    window.anton_top4k_loaded = true;

    var ROW_NAME = 'anton_top_4k';
    var ROW_TITLE = 'Главное в 4K';
    var CACHE_KEY = 'anton_top4k_cache_v3';
    var CACHE_HOURS = 6;
    var PAGES = 12;           // страниц ленты релизов (≈20 на страницу, ≈ последний квартал цифровых релизов)
    var MAX_ITEMS = 20;

    var A24_COMPANY = 41077;  // A24 в TMDB
    var HORROR_GENRE = 27;

    // Ужасы, которые показываем несмотря на фильтр (оригинальное название, без учёта регистра)
    var HORROR_ALLOW = ['backrooms'];

    // Пороги значимости
    var MIN_VOTES_BLOCKBUSTER = 1000;
    var MIN_POPULARITY = 150;
    var MIN_VOTES_ACCLAIMED = 300;
    var MIN_RATING_ACCLAIMED = 7.5;

    // Настройки
    var S_PERIOD = 'anton_top4k_period2';  // '365' | '730' | '1095' — давность премьеры
    var S_SORT = 'anton_top4k_sort2';      // 'release' | 'date' | 'popular'
    var S_NOHORROR = 'anton_top4k_nohorror';

    function setting(name, def) {
        var v = Lampa.Storage.get(name, '');
        return v === '' ? def : v;
    }

    function periodDays() { return parseInt(setting(S_PERIOD, '730')) || 730; }
    function sortMode() { return setting(S_SORT, 'release'); }
    function hideHorror() {
        var v = setting(S_NOHORROR, true);
        return v === true || v === 'true';
    }

    function releaseTime(card) {
        var d = card.release_date || card.first_air_date || '';
        var t = Date.parse(d);
        return isNaN(t) ? 0 : t;
    }

    function is4k(card) {
        var q = (card.release_quality || card.quality || '') + '';
        return /4k|2160|uhd/i.test(q);
    }

    function inPeriod(card) {
        var t = releaseTime(card);
        if (!t) return false;
        return Date.now() - t <= periodDays() * 24 * 3600 * 1000;
    }

    function isHorrorBlocked(card) {
        if (!hideHorror()) return false;
        var genres = card.genre_ids || (card.genres || []).map(function (g) { return g.id; });
        if (genres.indexOf(HORROR_GENRE) === -1) return false;
        var title = ((card.original_title || card.original_name || '') + ' ' + (card.title || card.name || '')).toLowerCase();
        return !HORROR_ALLOW.some(function (w) { return title.indexOf(w) >= 0; });
    }

    function isSignificant(card, a24) {
        if (a24[card.id]) return true;
        var votes = card.vote_count || 0;
        var rating = card.vote_average || 0;
        var pop = card.popularity || 0;
        if (votes >= MIN_VOTES_BLOCKBUSTER) return true;
        if (pop >= MIN_POPULARITY) return true;
        if (votes >= MIN_VOTES_ACCLAIMED && rating >= MIN_RATING_ACCLAIMED) return true;
        return false;
    }

    function cacheKey() {
        return CACHE_KEY + '_' + periodDays() + '_' + sortMode() + '_' + (hideHorror() ? 1 : 0);
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

    function loadA24(done) {
        var a24 = {};
        var pending = 2;
        var net = new Lampa.Reguest();

        function finish() { if (--pending === 0) done(a24); }

        ['movie', 'tv'].forEach(function (type) {
            var url = Lampa.TMDB.api('discover/' + type +
                '?with_companies=' + A24_COMPANY +
                '&sort_by=' + (type === 'movie' ? 'primary_release_date' : 'first_air_date') + '.desc' +
                '&api_key=' + Lampa.TMDB.key() + '&language=ru');

            net.silent(url, function (json) {
                (json && json.results || []).forEach(function (c) { a24[c.id] = true; });
                finish();
            }, finish);
        });
    }

    function loadReleases(done) {
        var all = [];
        var pending = PAGES;

        function finish() { if (--pending === 0) done(all); }

        for (var p = 1; p <= PAGES; p++) (function (page) {
            try {
                Lampa.Api.relise({ page: page }, function (data) {
                    (data && data.results || []).forEach(function (c, i) {
                        c._anton_order = page * 1000 + i;
                        all.push(c);
                    });
                    finish();
                }, finish);
            } catch (e) { finish(); }
        })(p);
    }

    var lastStats = null;

    function build(done, force) {
        var cached = force ? null : readCache();
        if (cached) return done(cached);

        loadA24(function (a24) {
            loadReleases(function (cards) {
                var seen = {};
                var unique = cards.filter(function (c) {
                    if (!c || !c.id || seen[c.id]) return false;
                    seen[c.id] = true;
                    return true;
                });

                var uhd = unique.filter(is4k);
                var recent = uhd.filter(inPeriod);
                var noHorror = recent.filter(function (c) { return !isHorrorBlocked(c); });
                var results = noHorror.filter(function (c) { return isSignificant(c, a24); });

                if (sortMode() === 'popular') {
                    results.sort(function (a, b) {
                        return ((b.popularity || 0) + (a24[b.id] ? 50 : 0)) - ((a.popularity || 0) + (a24[a.id] ? 50 : 0));
                    });
                } else if (sortMode() === 'date') {
                    results.sort(function (a, b) { return releaseTime(b) - releaseTime(a); });
                } else {
                    // порядок ленты релизов = свежесть выхода в цифре
                    results.sort(function (a, b) { return (a._anton_order || 0) - (b._anton_order || 0); });
                }

                results = results.slice(0, MAX_ITEMS);

                lastStats = {
                    releases: unique.length,
                    uhd: uhd.length,
                    recent: recent.length,
                    noHorror: noHorror.length,
                    significant: results.length,
                    titles: results.slice(0, 8).map(function (c) { return c.title || c.name; })
                };

                if (results.length) writeCache(results);
                done(results);
            });
        });
    }

    function supported() {
        return !!(Lampa.ContentRows && Lampa.Api && typeof Lampa.Api.relise === 'function');
    }

    function clearCache() {
        try {
            ['365', '730', '1095'].forEach(function (p) {
                ['release', 'date', 'popular'].forEach(function (s) {
                    [0, 1].forEach(function (h) {
                        Lampa.Storage.set(CACHE_KEY + '_' + p + '_' + s + '_' + h, {});
                    });
                });
            });
        } catch (e) {}
    }

    function diagnose() {
        if (!supported()) {
            return Lampa.Noty.show('Главное в 4K: эта версия Lampa не поддерживает ряды на главной');
        }
        Lampa.Noty.show('Главное в 4K: собираю список…');
        build(function (results) {
            var st = lastStats || {};
            Lampa.Noty.show('Релизов: ' + (st.releases || 0) +
                ', в 4K: ' + (st.uhd || 0) +
                ', премьера в пределах: ' + (st.recent || 0) +
                ', без ужасов: ' + (st.noHorror || 0) +
                ', в ряду: ' + results.length +
                (st.titles && st.titles.length ? '. ' + st.titles.join(', ') : ''));
        }, true);
    }

    function addSettings() {
        if (!Lampa.SettingsApi) return;
        try {
            Lampa.SettingsApi.addParam({
                component: 'anton_plugins',
                param: { name: S_PERIOD, type: 'select', values: { '365': '1 год', '730': '2 года', '1095': '3 года' }, 'default': '730' },
                field: { name: 'Главное в 4K: премьера не старше', description: 'Отсекает старые фильмы, переизданные в 4K' },
                onChange: clearCache
            });
            Lampa.SettingsApi.addParam({
                component: 'anton_plugins',
                param: { name: S_SORT, type: 'select', values: { 'release': 'Недавно вышли в 4K', 'date': 'По дате премьеры', 'popular': 'Сначала популярные' }, 'default': 'release' },
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
                    build(function (results) {
                        if (!results.length) return call();
                        call({
                            title: ROW_TITLE,
                            results: results.map(function (c) {
                                var copy = Object.assign({}, c);
                                if (!copy.source) copy.source = 'tmdb';
                                return copy;
                            })
                        });
                    });
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
