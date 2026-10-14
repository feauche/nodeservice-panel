import { describe, expect, it } from 'vitest';
import { CHANNEL_MBPS_MAX, parseChannelSpeed } from './channel-speed';

describe('скорость канала из вывода команды', () => {
  it('пусто — ничего не распознано', () => {
    expect(parseChannelSpeed('')).toEqual({ kind: 'empty' });
    expect(parseChannelSpeed('   \n ')).toEqual({ kind: 'empty' });
  });

  it('одно число — как есть, с пробелом, запятой и единицей', () => {
    expect(parseChannelSpeed('1000')).toEqual({ kind: 'number', mbps: 1000 });
    expect(parseChannelSpeed('1000\n')).toEqual({ kind: 'number', mbps: 1000 });
    expect(parseChannelSpeed('1 000')).toEqual({ kind: 'number', mbps: 1000 });
    expect(parseChannelSpeed('1,000')).toEqual({ kind: 'number', mbps: 1000 });
    expect(parseChannelSpeed('940,5')).toEqual({ kind: 'number', mbps: 940.5 });
    expect(parseChannelSpeed('940.5')).toEqual({ kind: 'number', mbps: 940.5 });
    // Виртуальная сетевая карта пишет 10000, хотя по тарифу меньше: число берётся как есть, решает человек.
    expect(parseChannelSpeed('10000')).toEqual({ kind: 'number', mbps: 10000 });
    expect(parseChannelSpeed('940 Mbps')).toEqual({ kind: 'number', mbps: 940 });
    expect(parseChannelSpeed('1 Gbit/s')).toEqual({ kind: 'number', mbps: 1000 });
    expect(parseChannelSpeed('2,5 Гбит/с')).toEqual({ kind: 'number', mbps: 2500 });
    expect(parseChannelSpeed('1000 Мбит/с')).toEqual({ kind: 'number', mbps: 1000 });
  });

  it('замер speedtest-cli: берётся меньшее из Download и Upload, округляется', () => {
    const out = 'Ping: 14.2 ms\nDownload: 912.31 Mbit/s\nUpload: 874.07 Mbit/s';
    expect(parseChannelSpeed(out)).toEqual({ kind: 'measured', mbps: 874, download: 912.31, upload: 874.07 });
    // Upload больше Download — берётся Download.
    expect(parseChannelSpeed('Download: 300.4 Mbit/s\nUpload: 700 Mbit/s')).toMatchObject({
      kind: 'measured',
      mbps: 300,
    });
  });

  it('замер: гигабиты переводятся в мегабиты, Ookla с хвостом «data used» читается', () => {
    expect(parseChannelSpeed('Download: 1.2 Gbit/s\nUpload: 900 Mbit/s')).toMatchObject({
      kind: 'measured',
      mbps: 900,
      download: 1200,
    });
    const ookla =
      '   Download:   912.31 Mbps (data used: 1.1 GB)\n     Upload:   874.07 Mbps (data used: 800 MB)';
    expect(parseChannelSpeed(ookla)).toMatchObject({ kind: 'measured', mbps: 874 });
  });

  it('замер без одного направления берёт то, что есть', () => {
    expect(parseChannelSpeed('Download: 640 Mbit/s')).toEqual({
      kind: 'measured',
      mbps: 640,
      download: 640,
      upload: null,
    });
    expect(parseChannelSpeed('Upload: 120 Mbit/s')).toMatchObject({ mbps: 120, download: null, upload: 120 });
  });

  it('ethtool: «Speed: 1000Mb/s» читается, «Unknown!» — сервер не сообщает', () => {
    expect(parseChannelSpeed('Settings for eth0:\n\tSpeed: 1000Mb/s\n\tDuplex: Full')).toEqual({
      kind: 'number',
      mbps: 1000,
    });
    expect(parseChannelSpeed('\tSpeed: Unknown!\n\tDuplex: Unknown! (255)')).toEqual({ kind: 'unknown' });
  });

  it('сервер скорость не сообщает: ошибка и −1 не становятся числом', () => {
    expect(parseChannelSpeed('cat: read error: Invalid argument')).toEqual({ kind: 'unknown' });
    expect(parseChannelSpeed('-1')).toEqual({ kind: 'unknown' });
    expect(parseChannelSpeed('−1')).toEqual({ kind: 'unknown' });
    expect(parseChannelSpeed('cat: /sys/class/net/eth0/speed: No such file or directory')).toEqual({
      kind: 'unknown',
    });
  });

  it('кусок консоли с приглашением и командой: берётся единственная строка с числом', () => {
    const shell =
      "root@host:~# cat /sys/class/net/$(ip route show default | awk '{print $5; exit}')/speed\n1000\nroot@host:~#";
    expect(parseChannelSpeed(shell)).toEqual({ kind: 'number', mbps: 1000 });
    expect(parseChannelSpeed('root@host:~# cat /sys/class/net/eth0/speed\n-1\nroot@host:~#')).toEqual({
      kind: 'unknown',
    });
  });

  it('непонятное не превращается в число: слова, несколько чисел, «10 20»', () => {
    expect(parseChannelSpeed('очень быстро')).toEqual({ kind: 'unclear' });
    expect(parseChannelSpeed('10 20')).toEqual({ kind: 'unclear' });
    expect(parseChannelSpeed('root@host:~# uptime\n 12:00 up 3 days\n100\n200')).toEqual({ kind: 'unclear' });
    expect(parseChannelSpeed('speedtest: command failed')).toEqual({ kind: 'unclear' });
  });

  it('невозможная скорость — отдельный итог: ноль и больше предела поля', () => {
    expect(parseChannelSpeed('0')).toEqual({ kind: 'range' });
    expect(parseChannelSpeed(String(CHANNEL_MBPS_MAX + 1))).toEqual({ kind: 'range' });
    expect(parseChannelSpeed(String(CHANNEL_MBPS_MAX))).toEqual({ kind: 'number', mbps: CHANNEL_MBPS_MAX });
    expect(parseChannelSpeed('Download: 0.2 Mbit/s')).toEqual({ kind: 'range' });
  });
});
