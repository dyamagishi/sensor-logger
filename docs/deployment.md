# NanoPi NEO2への導入・更新

## 動作構成

ARM64 Linux・systemd・BlueZ・BLE対応USBアダプターを使います。NanoPi NEO2、kernel 4.14.111 / BlueZ 5.53、CSR8510 A10でHCI直接受信を確認しています。

BlueZのD-Bus探索が更新停止する環境を考慮し、受信は `receiver = "hci"` を使います。専用アダプターで別の探索や接続を同時に行わないでください。unitは起動前にBluetoothサービスを初期化し、HCI操作用に `CAP_NET_RAW` と `CAP_NET_ADMIN` を付与します。

以下の `nanopi-neo2` はSSH設定の接続先例です。自分の機器に置き換えてください。

## 初回導入

1. Macで `config/sensors.toml` を設定例から作成し、`npm run build` と `sh scripts/build-rust.sh` を実行します。
2. NanoPiにサービスユーザーと配置先を用意します（Debian系の例）。

```sh
ssh nanopi-neo2 'sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin home-sensors && sudo install -d -m 755 /opt/home-sensors /opt/home-sensors/config'
```

3. バイナリ、`dist/`、センサー設定を転送し、以下の場所に配置します。

| ローカル | 本体 |
| --- | --- |
| `target/aarch64-unknown-linux-musl/release/home-sensors` | `/opt/home-sensors/home-sensors`（0755） |
| `dist/` | `/opt/home-sensors/dist/` |
| `config/sensors.toml` | `/opt/home-sensors/config/sensors.toml` |
| `deploy/home-sensors.service` | `/etc/systemd/system/home-sensors.service`（0644） |

4. `config/home-sensors.env.example` を元に `/etc/home-sensors.env` を作成します。root所有・0600にし、必要ならクラウドURLと書込・読取トークンを設定します。ローカルのみの場合もファイルは作成します。
5. サービスを有効化します。

```sh
ssh nanopi-neo2 'sudo systemctl daemon-reload && sudo systemctl enable --now home-sensors'
```

`/run/home-sensors` と `/var/lib/home-sensors` はsystemdが作成します。Web画面は `http://<本体のホスト名またはIP>:8080/` です。

## 更新

再起動でRAM上の未送信記録が失われるため、`/api/status` の `cloud.pending` が0になった直後に更新します。

1. Macでテストとビルドを実行します。

```sh
cargo test --locked
sh scripts/build-rust.sh
```

2. 新バイナリを一時配置し、`--version` で実行できることを確認します。`/opt/home-sensors` がSSHユーザーの書込先ではない場合、一時ディレクトリへ転送して `sudo install` で配置してください。
3. 現行バイナリを `home-sensors.previous`、unitを `home-sensors.service.previous` として保存します。
4. サービス停止、新バイナリの配置、必要ならunit・画面の更新、daemon-reload、起動の順に実施します。設定・環境変数・追加登録ファイルは引き継ぎます。
5. `events` / `observed_at` の増加、分境界後の `history_points` 増加、毎時送信後の `last_sent` 更新を確認します。

```sh
ssh nanopi-neo2 'systemctl show home-sensors -p ExecStart -p MemoryCurrent -p NRestarts'
ssh nanopi-neo2 'curl -fsS http://localhost:8080/api/status'
```

不具合時は停止して `.previous` のバイナリ・unitを戻し、daemon-reload後に再起動します。

## 実装と検証

- `rust/ble.rs`: HCI広告・スキャン応答の併合、温湿度・CO₂解析、再接続・探索。
- `rust/store.rs`: 毎分記録、24時間のRAM履歴・送信キュー。
- `rust/cloud.rs`: 毎時送信、受領確認、登録同期、履歴キャッシュ・RAM併合。
- `rust/registry.rs`: アドレスからのID生成、0600設定の原子的保存。
- `rust/main.rs`: HTTP API、同一Origin・専用ヘッダー検査、32 KiB入力上限、エラーログ。

Rustテストは広告解析・切断パケット・不正値、分の繰越禁止、期限切れ、探索・二重登録・CSRF・設定保存、送信受領不一致時の保持・再試行・1,000件分割、履歴キャッシュと部分RAMの併合を確認します。HCIソケットはLinux実機で確認してください。
