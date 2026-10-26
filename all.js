/*
 * Загрузчик плагинов Антона для Lampa.
 * Достаточно один раз добавить в Lampa этот адрес:
 *   https://antonkarelsky.github.io/lampa-plugins/all.js
 * Остальные плагины из этого репозитория подключаются автоматически по списку ниже.
 */
(function () {
    'use strict';

    if (window.anton_plugins_loader) return;
    window.anton_plugins_loader = true;

    var BASE = 'https://antonkarelsky.github.io/lampa-plugins/';

    // Список подключаемых плагинов. Новые добавляются сюда.
    var PLUGINS = [
        'torrserver-watchdog.js'
    ];

    // Метка версии по дням: браузер Lampa заново скачивает плагины раз в сутки
    var version = new Date().toISOString().slice(0, 10);

    PLUGINS.forEach(function (name) {
        var script = document.createElement('script');
        script.src = BASE + name + '?v=' + version;
        script.async = true;
        script.onerror = function () {
            console.log('Anton plugins: не удалось загрузить ' + name);
        };
        document.head.appendChild(script);
    });
})();
