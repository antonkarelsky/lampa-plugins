/*
 * Загрузчик плагинов Антона для Lampa.
 * Один раз добавить в Lampa адрес:
 *   https://antonkarelsky.github.io/lampa-plugins/all.js
 *
 * В Настройках Lampa появится раздел «Мои плагины» с переключателем для каждого плагина.
 * Список плагинов берётся из plugins.json при каждом запуске Lampa,
 * поэтому новые плагины и исправления появляются сразу после перезапуска.
 */
(function () {
    'use strict';

    if (window.anton_plugins_loader) return;
    window.anton_plugins_loader = true;

    var BASE = 'https://antonkarelsky.github.io/lampa-plugins/';
    var COMPONENT = 'anton_plugins';
    var PREFIX = 'anton_plugin_';

    function bust(url) {
        return url + (url.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
    }

    function isEnabled(plugin) {
        var key = PREFIX + plugin.id;
        var stored = Lampa.Storage.get(key, '');
        if (stored === '') return plugin['default'] !== false;
        return stored === true || stored === 'true';
    }

    function loadScript(plugin) {
        var script = document.createElement('script');
        script.src = bust(BASE + plugin.file);
        script.async = true;
        script.onerror = function () {
            console.log('Мои плагины: не удалось загрузить ' + plugin.file);
        };
        document.head.appendChild(script);
    }

    function buildSettings(plugins) {
        if (!Lampa.SettingsApi) return;

        Lampa.SettingsApi.addComponent({
            component: COMPONENT,
            name: 'Мои плагины',
            icon: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
                  '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" stroke="currentColor" stroke-width="2"/></svg>'
        });

        plugins.forEach(function (plugin) {
            Lampa.SettingsApi.addParam({
                component: COMPONENT,
                param: {
                    name: PREFIX + plugin.id,
                    type: 'trigger',
                    'default': plugin['default'] !== false
                },
                field: {
                    name: plugin.name,
                    description: plugin.description || ''
                },
                onChange: function () {
                    Lampa.Noty.show('Изменения применятся после перезапуска Lampa');
                }
            });
        });
    }

    function start() {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', bust(BASE + 'plugins.json'), true);
        xhr.timeout = 10000;
        xhr.onload = function () {
            var plugins = [];
            try { plugins = JSON.parse(xhr.responseText); } catch (e) {}
            if (!Array.isArray(plugins)) return;

            buildSettings(plugins);
            plugins.forEach(function (plugin) {
                if (isEnabled(plugin)) loadScript(plugin);
            });
        };
        xhr.onerror = xhr.ontimeout = function () {
            console.log('Мои плагины: не удалось получить список плагинов');
        };
        xhr.send();
    }

    if (window.appready) start();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') start();
        });
    }
})();
