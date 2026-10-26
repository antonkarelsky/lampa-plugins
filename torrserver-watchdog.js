/*
 * TorrServer Watchdog — плагин для Lampa
 * Проверяет, отвечает ли TorrServer:
 *  - при запуске Lampa;
 *  - когда Lampa снова выходит на экран (вернулись из другого приложения);
 *  - при открытии карточки фильма или сериала.
 * Если сервер не отвечает — показывает уведомление с подсказкой.
 * В «Моих плагинах» есть кнопка «Проверить TorrServer сейчас».
 * Обращается только к адресу TorrServer из настроек Lampa.
 */
(function () {
    'use strict';

    if (window.torrserver_watchdog_loaded) return;
    window.torrserver_watchdog_loaded = true;

    var CHECK_TIMEOUT = 5000;      // сколько ждать ответа сервера, мс
    var RECHECK_COOLDOWN = 30000;  // автоматически не чаще раза в 30 секунд
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

    // manual = true: проверка по кнопке, сообщаем результат в любом случае
    function check(force, manual) {
        var now = Date.now();
        if (!force && now - lastCheck < RECHECK_COOLDOWN) return;
        lastCheck = now;

        var url = getServerUrl();
        if (!url) {
            if (manual) notify('Адрес TorrServer не задан в настройках Lampa');
            return;
        }

        var xhr = new XMLHttpRequest();
        var finished = false;

        function done(ok) {
            if (finished) return;
            finished = true;

            if (!ok) {
                notify('TorrServer не отвечает. Откройте приложение TorrServe и запустите сервер.');
            } else if (manual) {
                notify('TorrServer работает (' + url + ')');
            } else if (lastOk === false) {
                notify('TorrServer снова на связи');
            }
            lastOk = ok;
        }

        try {
            xhr.open('GET', url + '/echo?t=' + now, true);
            xhr.timeout = CHECK_TIMEOUT;
            xhr.onload = function () { done(xhr.status >= 200 && xhr.status < 500); };
            xhr.onerror = function () { done(false); };
            xhr.ontimeout = function () { done(false); };
            xhr.send();
        } catch (e) {
            done(false);
        }
    }

    function addSettingsButton() {
        if (!Lampa.SettingsApi) return;
        try {
            Lampa.SettingsApi.addParam({
                component: 'anton_plugins',
                param: { name: 'torrserver_watchdog_check_now', type: 'button' },
                field: {
                    name: 'Проверить TorrServer сейчас',
                    description: 'Сторож TorrServer: ручная проверка сервера'
                },
                onChange: function () { check(true, true); }
            });
        } catch (e) {}
    }

    function init() {
        addSettingsButton();

        // Первая проверка через 3 секунды после запуска
        setTimeout(function () { check(true); }, 3000);

        // Lampa снова на экране после другого приложения
        document.addEventListener('visibilitychange', function () {
            if (!document.hidden) setTimeout(function () { check(false); }, 1500);
        });

        // Открытие карточки фильма или сериала
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
