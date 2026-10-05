# おうちの空気 / Sensor Logger

NanoPi R5S (OpenWrt) でSwitchBotのBLE広告を受信し、温度・湿度・CO₂をブラウザで表示するサービスです。収集・Web APIはRust、画面はTypeScript、クラウド保存はCloudflare Workers + D1を使います。

## 特徴

- LinuxのHCIソケットから直接BLE広告を受信。Meter / Meter Plus / 防水温湿度計 / Meter Pro / Meter Pro CO₂に対応。
- 毎分、実際に受信した最後の値を記録。未受信の分は補完しません。
- 本体の履歴・再送キューはRAM上の24時間分。クラウドへ毎時、最大1,000件ずつ送信します。
- クラウドには分データを90日、時間ごとの平均・最小・最大・件数を5年保存します。
- 1日・7日・30日は1分単位、1年は時間集計のグラフを表示。未送信分はRAMの記録と併合します。
- GUIからセンサーを探索・登録。追加設定だけを永続化し、最大32台まで扱えます。
- ブラウザは本体へアクセスし、クラウド用トークンは受け取りません。
- 電池20%以下を注意、10%以下を交換の目安として表示します。
- Philips Hueの個々の照明を選択・操作し、1分ごとの点灯状態・明るさ・色を記録。設定生成用の管理者CLIを備えます。[Hueのセットアップと仕様](docs/hue.md)。

本体Web画面は信頼できるLAN内での利用を想定し、ログイン認証はありません。再起動・電源断ではRAM上の未送信分が失われます。

## 開発環境

Rust / Cargo / rustup、Node.js / npm、uvを用意してください。uvはMac側のクロスビルドツール導入と任意の監視スクリプトに使います。

```sh
npm ci
cp config/sensors.example.toml config/sensors.toml
cp wrangler.example.jsonc wrangler.jsonc
cargo test --locked
npm run test:cloud
npm run test:hue
npx tsc --noEmit
npm run build
```

`config/sensors.toml` のアドレスを実機のBLEアドレスに変更します。GUIからすべて登録する場合は `[[sensors]]` のブロックを削除し、トップレベルに `sensors = []` を設定します。

BLEなしでローカルのWeb API・画面を確認する場合:

```sh
cargo run -- --no-ble
# http://localhost:8080/
```

`--config PATH` と `--dist PATH` で設定・画面の場所を指定できます。実際のHCI受信にはLinuxとBluetoothアダプターが必要です。

## Macからクロスコンパイル

```sh
sh scripts/build-rust.sh
```

Macへcargo-zigbuildとZigを導入し、`aarch64-unknown-linux-musl` 向けに静的リンクします。成果物は `target/aarch64-unknown-linux-musl/release/home-sensors`。NanoPiでのコンパイルは不要で、glibc・OpenSSL・Pythonへの実行時依存もありません。

本体への初回導入・更新は [docs/deployment.md](docs/deployment.md) を参照してください。

## クラウド設定

コピーした `wrangler.jsonc` の `account_id` と `database_id` に、自分のCloudflareアカウント・D1データベースのIDを設定します。`vars.SENSOR_IDS` は、TOMLにあらかじめ登録するセンサーの `id` と揃えてください。GUIで追加したセンサーは毎時送信前に自動登録します。

管理用コマンドは、専用の `home-sensors` 認証プロファイルを使うラッパーから実行します。シェルのCloudflare認証変数を引き継がず、defaultプロファイルとは分離します。

```sh
npm run cf -- auth create home-sensors --scopes account:read user:read workers:write workers_scripts:write d1:write
npm run cf -- d1 create home-sensors
# 作成したD1のIDをwrangler.jsoncへ記入
npm run cf -- d1 migrations apply home-sensors --remote
npm run cf -- secret put INGEST_TOKEN
npm run cf -- secret put READ_TOKEN
npm run cf -- deploy
```

読み書き用に異なるランダムなトークンを設定し、本体の `/etc/home-sensors.env` にも同じ値を設定します。書式は `config/home-sensors.env.example` を参照してください。`SENSOR_CLOUD_URL` は配備したWorkerのURLです。空欄ならローカルのみで動作します。

ローカルのWorker検証用トークンは `node scripts/init-secrets.mjs` で生成できます。

```sh
node scripts/init-secrets.mjs
npm run cf -- d1 migrations apply home-sensors --local
npm run cf -- dev --local --port 8787
```

## 日常の確認

以下の `nanopi-r5s-b` は自分のSSH接続先に置き換えてください（NanoPi R5S の LAN-B 側、`192.168.53.1`）。

```sh
ssh nanopi-r5s-b '/etc/init.d/home-sensors status'
ssh nanopi-r5s-b 'wget -qO- http://192.168.53.1:8080/api/status'
ssh nanopi-r5s-b 'tail -40 /tmp/home-sensors/service.log'
```

両センサーの `events` と `observed_at` が増えることを確認します。`collector.state=scanning` だけでは受信の証拠になりません。`cloud.pending` は送信待ち件数、`dropped` は24時間の期限切れ件数です。

BLE診断は登録済みセンサーごとに5分に1行、同じサービスログへ `INFO BLE` として出力します（生パケット・未登録機器は出力しません）。`received` はその期間の広告レポート数、`accepted` は採用数、`skipped` は読み飛ばした理由別の件数、`missing_co2` はCO₂機器でCO₂値のない採用数です。`raw_age_seconds` と `valid_age_seconds` で、電波自体が途絶えたのか、受信しても採用できないのかを区別できます。`None` は未受信、`rssi` は最後の広告の電波強度です。集約時に3分以上更新がなければ `state=stale`、前回の集約で停止し今回は受信できていれば `state=recovered` になります。短い停止・復帰は集約の間に収まると状態表示には残りません。

ログは `/tmp/home-sensors/` で512 KiB×2世代にローテーションします。GUI追加設定は `/etc/home-sensors/sensors.json` に原子的に保存し、計測記録はRAMに保持します。起動はOpenWrtのprocd（`/etc/init.d/home-sensors`）で行い、BLEアダプタ（hci0）はアプリが直接初期化するためBlueZは不要です。

## HTTP API

本体は LAN-B 内限定のHTTP API（`http://192.168.53.1:8080`）を提供します。認証はなく、書き込み（POST）は専用ヘッダーが必要です。詳細な仕様と `curl` 例は [docs/api.md](docs/api.md) を参照してください。

## 長時間監視（任意）

`scripts/monitor.py` はMacから1分ごとにステータスを確認し、`artifacts/monitor.jsonl` へ記録する補助ツールです。収集サービスの動作には不要です。

```sh
uv run --no-project --python 3.12 python scripts/monitor.py --url http://192.168.53.1:8080 --hours 24
```

URLは自分の機器に変更してください。Macのスリープ・ネットワーク切断で監視は途切れますが、本体の収集は独立して動作します。

## 設定と公開対象

リポジトリには設定例だけを収録します。実機設定 `config/sensors.toml`、`wrangler.jsonc`、認証情報 `.auth/`・`.dev.vars`、監視結果 `artifacts/`、個別の検証メモ `docs/local/` はGit対象外です。テストのBLEアドレスも架空の値です。
