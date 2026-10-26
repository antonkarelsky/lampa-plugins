/*
 * «Главное в 4K» — плагин для Lampa
 *
 * Ряд на главной странице: только значимые новинки, которые уже вышли в 4K.
 * Источник новинок и качества — лента релизов Lampa (CUB, поле release_quality).
 * Значимость определяется по данным TMDB:
 *   - фильмы студии A24 — всегда;
 *   - популярные: много оценок или высокая популярность;
 *   - резонансные: высокий рейтинг при заметном числе оценок.
 * Результат кэшируется на 6 часов, чтобы не нагружать главную.
 */
(function () {
    'use strict';

    if (window.anton_top4k_loaded) return;
    window.anton_top4k_loaded = true;

    var ROW_NAME = 'anton_top_4k';
    var ROW_TITLE = 'Главное в 4K';
    var CACHE_KEY = 'anton_top4k_cache';
    var CACHE_HOURS = 6;
    var PAGES = 4;            // страниц ленты релизов (≈20 фильмов на страницу)
    var MAX_ITEMS = 20;

    var A24_COMPANY = 41077;  // A24 в TMDB

    // Пороги значимости
    var MIN_VOTES_POPULAR = 500;     // много оценок
    var MIN_POPULARITY = 80;         // высокая популярность TMDB
    var MIN_VOTES_ACCLAIMED = 150;   // для «резонансных»
    var MIN_RATING_ACCLAIMED = 7.3;

    function is4k(card) {
        var q = (card.release_quality || card.quality || '') + '';
        return /4k|2160|uhd/i.test(q);
    }

    function isSignificant(card, a24) {
        if (a24[card.id]) return true;
        var votes = card.vote_count || 0;
        var rating = card.vote_average || 0;
        var pop = card.popularity || 0;
        if (votes >= MIN_VOTES_POPULAR) return true;
        if (pop >= MIN_POPULARITY) return true;
        if (votes >= MIN_VOTES_ACCLAIMED && rating >= MIN_RATING_ACCLAIMED) return true;
        return false;
    }

    function score(card, a24) {
        return (card.popularity || 0) + (a24[card.id] ? 50 : 0) + (card.vote_average || 0) * 3;
    }

    function readCache() {
        try {
            var c = Lampa.Storage.get(CACHE_KEY, '{}');
            if (typeof c === 'string') c = JSON.parse(c);
            if (c && c.time && Date.now() - c.time < CACHE_HOURS * 3600 * 1000 && c.results) return c.results;
        } catch (e) {}
        return null;
    }

    function writeCache(results) {
        try { Lampa.Storage.set(CACHE_KEY, { time: Date.now(), results: results }); } catch (e) {}
    }

    // A24: последние фильмы и сериалы студии (id в TMDB)
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

    // Лента релизов Lampa: несколько страниц
    function loadReleases(done) {
        var all = [];
        var pending = PAGES;

        function finish() { if (--pending === 0) done(all); }

        for (var page = 1; page <= PAGES; page++) {
            try {
                Lampa.Api.relise({ page: page }, function (data) {
                    (data && data.results || []).forEach(function (c) { all.push(c); });
                    finish();
                }, finish);
            } catch (e) { finish(); }
        }
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
                var results = uhd.filter(function (c) { return isSignificant(c, a24); });

                var qualities = {};
                unique.forEach(function (c) {
                    var q = (c.release_quality || c.quality || '—') + '';
                    qualities[q] = (qualities[q] || 0) + 1;
                });
                lastStats = {
                    releases: unique.length,
                    uhd: uhd.length,
                    significant: results.length,
                    a24: Object.keys(a24).length,
                    qualities: qualities
                };

                results.sort(function (a, b) { return score(b, a24) - score(a, a24); });
                results = results.slice(0, MAX_ITEMS);

                if (results.length) writeCache(results);
                done(results);
            });
        });
    }

    function supported() {
        return !!(Lampa.ContentRows && Lampa.Api && typeof Lampa.Api.relise === 'function');
    }

    function diagnose() {
        if (!supported()) {
            return Lampa.Noty.show('Главное в 4K: эта версия Lampa не поддерживает ряды на главной');
        }
        Lampa.Noty.show('Главное в 4K: собираю список…');
        build(function (results) {
            var st = lastStats || {};
            var q = Object.keys(st.qualities || {}).slice(0, 6).map(function (k) {
                return k + ': ' + st.qualities[k];
            }).join(', ');
            Lampa.Noty.show('Релизов: ' + (st.releases || 0) + ', в 4K: ' + (st.uhd || 0) +
                ', значимых: ' + results.length + '. A24: ' + (st.a24 || 0) +
                (q ? '. Качество: ' + q : ''));
        }, true);
    }

    function init() {
        if (Lampa.SettingsApi) {
            try {
                Lampa.SettingsApi.addParam({
                    component: 'anton_plugins',
                    param: { name: 'anton_top4k_diag', type: 'button' },
                    field: {
                        name: 'Главное в 4K: обновить и показать статистику',
                        description: 'Сбрасывает кэш и показывает, сколько релизов найдено'
                    },
                    onChange: diagnose
                });
            } catch (e) {}
        }

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
    }

    if (window.appready) init();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') init();
        });
    }
})();
