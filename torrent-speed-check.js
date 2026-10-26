/*
 * Проверка скорости раздачи — плагин для Lampa
 *
 * В списке торрентов: долгое нажатие ОК на раздаче → «Проверить скорость раздачи».
 * Плагин добавляет раздачу в TorrServer, ~25 секунд замеряет скорость загрузки
 * и сравнивает её с битрейтом видео:
 *   🟢 скорость ≥ 1,3 × битрейт — пойдёт ровно
 *   🟡 1,0–1,3 × битрейт — скорее всего пойдёт, возможны остановки
 *   🔴 меньше битрейта — будет тормозить
 * После проверки можно сразу начать просмотр или закрыть (торрент удаляется из активных).
 * Обращается только к TorrServer из настроек Lampa.
 */
(function () {
    'use strict';

    if (window.torrent_speed_check_loaded) return;
    window.torrent_speed_check_loaded = true;

    var MEASURE_SECONDS = 25;   // длительность замера
    var SKIP_SECONDS = 8;       // первые секунды торрент разгоняется — их не учитываем
    var META_TIMEOUT = 40;      // сколько ждать список файлов, секунд
    var GOOD_RATIO = 1.3;

    var VIDEO_EXT = /\.(mkv|mp4|avi|ts|m2ts|mov|wmv|webm|mpg|mpeg|vob|iso)$/i;

    function serverUrl() {
        var url = '';
        try { url = Lampa.Torserver.url(); } catch (e) {}
        if (!url) {
            var two = Lampa.Storage.field('torrserver_use_link') === 'two';
            url = Lampa.Storage.get(two ? 'torrserver_url_two' : 'torrserver_url', '');
        }
        url = (url || '').trim();
        if (url && !/^https?:\/\//i.test(url)) url = 'http://' + url;
        return url.replace(/\/+$/, '');
    }

    function post(path, body, success, fail, timeout) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', serverUrl() + path, true);
        xhr.timeout = timeout || 10000;
        xhr.onload = function () {
            if (xhr.status < 200 || xhr.status >= 300) return fail && fail();
            var data = xhr.responseText;
            try { data = JSON.parse(data); } catch (e) {}
            success && success(data);
        };
        xhr.onerror = xhr.ontimeout = function () { fail && fail(); };
        xhr.send(JSON.stringify(body));
        return xhr;
    }

    function mbit(bytesPerSec) {
        return bytesPerSec * 8 / 1000000;
    }

    function fmt(n) {
        return (Math.round(n * 10) / 10).toString().replace('.', ',');
    }

    function runtimeMinutes(movie) {
        if (!movie) return 0;
        if (movie.name || movie.number_of_seasons) {
            var ep = movie.episode_run_time;
            if (Array.isArray(ep) && ep.length) return parseInt(ep[0]) || 0;
            if (movie.last_episode_to_air && movie.last_episode_to_air.runtime) {
                return parseInt(movie.last_episode_to_air.runtime) || 0;
            }
        }
        return parseInt(movie.runtime) || 0;
    }

    function pickFile(files) {
        var videos = files.filter(function (f) { return VIDEO_EXT.test(f.path || ''); });
        var list = videos.length ? videos : files;
        return list.reduce(function (best, f) {
            return !best || (f.length || 0) > (best.length || 0) ? f : best;
        }, null);
    }

    function check(element, item, movie, prevController) {
        var link = element.MagnetUri || element.Link;
        if (!serverUrl()) return Lampa.Noty.show('Адрес TorrServer не задан в настройках Lampa');
        if (!link) return Lampa.Noty.show('У этой раздачи нет ссылки для проверки');

        var hash = null;
        var timers = [];
        var requests = [];
        var cancelled = false;
        var finished = false;

        var html = $(
            '<div class="anton-speed">' +
                '<div class="anton-speed__status" style="font-size:1.3em;margin-bottom:0.8em">Подключаюсь к раздаче…</div>' +
                '<div class="anton-speed__details" style="line-height:1.7"></div>' +
            '</div>'
        );
        var statusEl = html.find('.anton-speed__status');
        var detailsEl = html.find('.anton-speed__details');

        function setStatus(text) { statusEl.text(text); }
        function setDetails(lines) { detailsEl.html(lines.join('<br>')); }

        function cleanup() {
            timers.forEach(function (t) { clearInterval(t); clearTimeout(t); });
            timers = [];
            requests.forEach(function (r) { try { r.abort(); } catch (e) {} });
            requests = [];
        }

        function dropTorrent() {
            if (hash) post('/torrents', { action: 'drop', hash: hash }, null, null, 5000);
        }

        function closeModal() {
            cancelled = true;
            cleanup();
            Lampa.Modal.close();
            Lampa.Controller.toggle(prevController);
        }

        function closeAndDrop() {
            closeModal();
            dropTorrent();
        }

        function watch() {
            closeModal();
            setTimeout(function () { item.trigger('hover:enter'); }, 100);
        }

        Lampa.Modal.open({
            title: 'Проверка скорости раздачи',
            html: html,
            size: 'medium',
            onBack: closeAndDrop,
            buttons: [
                { name: 'Смотреть', onSelect: watch },
                { name: 'Закрыть', onSelect: closeAndDrop }
            ]
        });

        function fail(text) {
            if (cancelled) return;
            finished = true;
            cleanup();
            setStatus('⚠️ ' + text);
        }

        // 1. Добавляем торрент в TorrServer
        requests.push(post('/torrents', {
            action: 'add',
            link: link,
            title: '[LAMPA] ' + (element.Title || element.title || ''),
            poster: movie && movie.img ? movie.img : '',
            save_to_db: false
        }, function (data) {
            if (cancelled) return;
            hash = data && data.hash;
            if (!hash) return fail('TorrServer не принял раздачу');
            waitFiles();
        }, function () {
            fail('TorrServer не отвечает. Проверьте, что сервер запущен.');
        }, 30000));

        // 2. Ждём список файлов
        function waitFiles() {
            setStatus('Получаю список файлов…');
            var started = Date.now();

            function poll() {
                if (cancelled) return;
                requests.push(post('/torrents', { action: 'get', hash: hash }, function (data) {
                    if (cancelled) return;
                    var files = data && data.file_stats;
                    if (files && files.length) return measure(pickFile(files));
                    next();
                }, next, 5000));
            }

            function next() {
                if (cancelled) return;
                if ((Date.now() - started) / 1000 > META_TIMEOUT) {
                    return fail('Не удалось получить данные раздачи — похоже, у неё нет живых сидов.');
                }
                timers.push(setTimeout(poll, 1000));
            }

            poll();
        }

        // 3. Запускаем загрузку и замеряем скорость
        function measure(file) {
            if (!file) return fail('В раздаче не найдено видеофайлов');

            var name = (file.path || 'video').split('/').pop();
            var streamUrl = serverUrl() + '/stream/' + encodeURIComponent(name) +
                '?link=' + hash + '&index=' + file.id + '&preload';

            // Предзагрузка заставляет TorrServer начать качать файл
            var pre = new XMLHttpRequest();
            pre.open('GET', streamUrl, true);
            pre.timeout = (MEASURE_SECONDS + 30) * 1000;
            pre.send();
            requests.push(pre);

            var movieMin = runtimeMinutes(movie);
            var bitrate = movieMin ? (file.length * 8 / 1000000) / (movieMin * 60) : 0;

            var samples = [];
            var lastStat = {};
            var tick = 0;

            setStatus('Замеряю скорость… 0 / ' + MEASURE_SECONDS + ' с');

            var interval = setInterval(function () {
                if (cancelled || finished) return;
                tick++;

                requests.push(post('/cache', { action: 'get', hash: hash }, function (data) {
                    var t = data && data.Torrent;
                    if (!t) return;
                    lastStat = t;
                    if (tick > SKIP_SECONDS) samples.push(t.download_speed || 0);
                }, null, 3000));

                var now = lastStat.download_speed ? fmt(mbit(lastStat.download_speed)) + ' Мбит/с' : '—';
                setStatus('Замеряю скорость… ' + Math.min(tick, MEASURE_SECONDS) + ' / ' + MEASURE_SECONDS + ' с');
                setDetails([
                    'Сейчас: ' + now,
                    'Пиры: ' + (lastStat.active_peers || 0) + ' активных, ' +
                        (lastStat.connected_seeders || 0) + ' раздают',
                    bitrate ? 'Битрейт видео: ' + fmt(bitrate) + ' Мбит/с' : ''
                ]);

                if (tick >= MEASURE_SECONDS) {
                    clearInterval(interval);
                    // даём последнему запросу статистики вернуться
                    timers.push(setTimeout(function () { result(file, bitrate, samples, lastStat); }, 1200));
                }
            }, 1000);

            timers.push(interval);
        }

        // 4. Итог
        function result(file, bitrate, samples, stat) {
            if (cancelled) return;
            finished = true;

            // отменяем предзагрузку, но торрент оставляем — вдруг сразу «Смотреть»
            requests.forEach(function (r) { try { r.abort(); } catch (e) {} });
            requests = [];

            if (!samples.length) return fail('Раздача не отдаёт данные — скорее всего, нет живых сидов.');

            var avg = samples.reduce(function (a, b) { return a + b; }, 0) / samples.length;
            var speed = mbit(avg);
            var lines = ['Средняя скорость: <b>' + fmt(speed) + ' Мбит/с</b>'];

            if (bitrate) {
                var ratio = speed / bitrate;
                var verdict;
                if (ratio >= GOOD_RATIO) verdict = '🟢 Пойдёт ровно';
                else if (ratio >= 1) verdict = '🟡 Скорее всего пойдёт, возможны остановки';
                else verdict = '🔴 Будет тормозить — лучше выбрать другую раздачу';

                setStatus(verdict);
                lines.push('Битрейт видео: ' + fmt(bitrate) + ' Мбит/с');
                lines.push('Запас: ×' + fmt(ratio));
            } else {
                setStatus('Скорость измерена');
                lines.push('Битрейт неизвестен: в карточке нет длительности');
            }

            lines.push('Пиры: ' + (stat.active_peers || 0) + ' активных, ' +
                (stat.connected_seeders || 0) + ' раздают');
            lines.push('Файл: ' + Lampa.Utils.bytesToSize(file.length));

            setDetails(lines);
        }
    }

    function init() {
        Lampa.Listener.follow('torrent', function (e) {
            if (e.type !== 'onlong' || !e.menu) return;

            var element = e.element;
            var item = e.item;
            var prevController = Lampa.Controller.enabled().name;
            var activity = Lampa.Activity.active() || {};
            var movie = activity.movie || (activity.object && activity.object.movie) || null;

            e.menu.unshift({
                title: 'Проверить скорость раздачи',
                subtitle: 'Замер ~25 секунд и сравнение с битрейтом',
                onSelect: function () {
                    setTimeout(function () { check(element, item, movie, prevController); }, 50);
                }
            });
        });
    }

    if (window.appready) init();
    else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') init();
        });
    }
})();
