# E-badge Web BLE PoC v0.3.0

KEIYO / Beambox系 E-badge向けの静的Web Bluetooth実験アプリです。

## 配置

`index.html`, `app.js`, `app.css` を同じディレクトリへ置くだけです。すべて相対パスなので、

- `https://example.com/`
- `https://example.com/path/to/app/`
- `https://sub.example.com/a/b/c/`

など任意のFQDN・パス深さで動作します。


## MACクエリ

例:

`https://example.com/path/to/app/?mac=deadbeefcafe`

Web Bluetooth APIはBluetoothデバイスの実MACアドレスをWebページへ公開しません。そのため次の方式です。

1. 初回は「デバイスを選択」でユーザーが対象バッジを選ぶ
2. URLに`mac=`が指定されていれば、その値とブラウザ固有の`BluetoothDevice.id`をlocalStorageへ対応付ける
3. 次回以降は「優先デバイスに接続」で`navigator.bluetooth.getDevices()`から対応する許可済みデバイスを優先して接続

この対応付けは同一origin・同一ブラウザプロファイル内でのみ有効です。

## 現在のBLE仕様

- Advertised name: `E-badge`
- Advertised service: `0000af30-0000-1000-8000-00805f9b34fb`
- GATT service: `000001f0-0000-1000-8000-00805f9b34fb`
- TX: `000001f1-0000-1000-8000-00805f9b34fb` / Write Without Response
- RX: `000001f2-0000-1000-8000-00805f9b34fb` / Notify

静止画は368x368 JPEGへ変換し、IMBヘッダを付けて446-byte payloadへ分割、`F1 06`フレームとして送信します。

## デバッグ

デバッグタブで送受信ログをコピー・保存できます。実機検証時にこのログをそのまま共有すると解析しやすくなります。

## 注意

PoCです。IMBヘッダの一部フィールドは実機ログから観測した固定値を使用しています。またWeb Bluetooth実装ごとにWrite Without Responseのキュー挙動が異なる可能性があるため、初期値12msのチャンク間隔を設定しています。

## v0.2 実機確認反映

- `{GetPacketSuccess}` を転送成功ACKとして待機します。
- ACK後、次の device info (opcode 0x0D) を最大3秒待ち、既定ではGATTを自動切断します。
- バッジが接続中Bluetooth表示に残るケースを避けるための動作です。必要なら画像タブで自動切断をOFFにできます。
- `navigator.bluetooth.getDevices()` 非対応ブラウザでは `?mac=` による自動再接続はできず、Bluetooth chooserが開きます。

## v0.3.0

- 画像プレビューをドラッグしてクロップ位置を調整できます。
- 1.00〜3.00倍の拡大率で簡易ズームできます。
- 最終送信画像は従来どおり368x368 JPEGへ変換されます。
- 「全体表示」「引き伸ばし」も残しています。
- フッターにWebアプリのバージョンを常時表示します。
- CSS/JSの参照URLにもバージョンを付け、更新確認時のキャッシュ混乱を減らしています。


## v0.4.0

- HCIログから推定した animation protocol (`type:5`, BLE opcode `F1 05`) の実験送信を追加。
- ブラウザ内で 368x368 moving color bars をJPEGフレーム列として生成。
- 1/3/5秒、5/10/15/20/30fpsを選択可能。
- type 5 container: `0x12345678`, fixed 12-byte `output/<ms>ms`, `frame_00001.` directory, circular frame-record links, image type 11 を再現。
- まず 1秒 / 10fps の短いテストを推奨。

## v0.5.0

- Animation `fps` and protocol `intervalMs` are independently adjustable.
- Added local GIF / video import and sampling to 368x368 JPEG frame sequences.
- GIF decoding uses `ImageDecoder` when available; video uses a local HTMLVideoElement and canvas seeking.
- Animation ACK timeout now starts after the final BLE chunk, while the ACK listener is armed before transmission.
- Animation ACK wait increased to 30 seconds after the final chunk; still images use 15 seconds.
- Existing captured type-5 container structure is preserved: 0x12345678 header, frame directory, circular record links, JPEG records.
