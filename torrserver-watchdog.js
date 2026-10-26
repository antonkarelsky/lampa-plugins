/*
 * TorrServer Watchdog — плагин для Lampa
 * Проверяет, отвечает ли TorrServer, при запуске Lampa и при открытии карточки фильма.
 * Если сервер не отвечает — показывает уведомление с подсказкой.
 * Никаких внешних запросов: обращается только к адресу TorrServer из настроек Lampa.
 */
(function () {
    'use strict';

    if (window.torrserver_watchdog_loaded) return;
    window.torrserver_watchdog_loaded = true;

    var CHECK_TIMEOUT = 5000;        // сколько ждать ответа сервера, мс
    var RECHECK_COOLDOWN = 120000;   // не проверять чаще, чем раз в 2 минуты
    var lastCheck = 0;
    var lastOk = null;

    function getServerUrl() {
        var url = '';
        try {
            if (Lampa.Torserver && typeof Lampa.Torserver.url === 'function') {
                url = Lampa.Torserver.url();
            }
        } catch (e) {}

        if (!url) {
            var useTwo = Lampa.Storage.field('torrserver_use_link') === 'two';
            url = Lampa.Storage.get(useTwo ? 'torrserver_url_two' : 'torrserver_url', '');
        }

        url = (url || '').trim();
        if (!url) return '';
        if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
        return url.replace(/\/+$/, '');
    }

    function notify(text) {
        try {
            Lampa.Noty.show(text);
        } catch (e) {
            console.log('TorrServer Watchdog:', text);
        }
    }

    function check(force) {
        var now = Date.now();
        if (!force && now - lastCheck < RECHECK_COOLDOWN) return;
        lastCheck = now;

        var url = getServerUrl();
        if (!url) return; // TorrServer не настроен — молчим

        var xhr = new XMLHttpRequest();
        var finished = false;

        function done(ok) {
            if (finished) return;
            finished = true;

            if (!ok) {
                notify('TorrServer не отвечает. Откройте приложение TorrServe и запустите сервер.');
            } else if (lastOk === false) {
                notify('TorrServer снова на связи');
            }
            lastOk = ok;
        }

        try {
            xhr.open('GET', url + '/echo', true);
            xhr.timeout = CHECK_TIMEOUT;
            xhr.onload = function () { done(xhr.status >= 200 && xhr.status < 500); };
            xhr.onerror = function () { done(false); };
            xhr.ontimeout = function () { done(false); };
            xhr.send();
        } catch (e) {
            done(false);
        }
    }

    function init() {
        // Первая проверка через 3 секунды после запуска, чтобы не мешать загрузке
        setTimeout(function () { check(true); }, 3000);

        // Повторная проверка при открытии карточки фильма или сериала
        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite') check(false);
        });
    }

    if (window.appready) init();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') init();
        });
    }
})();
