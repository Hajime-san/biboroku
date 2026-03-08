# impl: createImageBitmap の遅延化

## 目的
- `createImageBitmap` の処理を可能な限り遅延し、仕様互換性・非破壊・性能向上を両立する。
- 互換性維持を最優先とし、破壊的変更は避ける。

## 背景の整理（要点）
- 仕様上 `ImageBitmap` の `[[BitmapData]]` は直接アクセスされないため、描画時に処理を遅延する余地がある。
- 既存ブラウザ実装は、少なくとも **decode は即時**で、色変換や premultiply は **描画時にオンザフライ**で実施されることがある。
- Chromium の [static_bitmap_image_transform.cc](static_bitmap_image_transform.cc) にある `ApplyUsingPixmap` のように、**CPU パスでの遅延変換**も成立している（GPU フォールバックの余地）。
- Deno の現行実装は `createImageBitmap` 時に `DynamicImage` を確定しているため、遅延化の余地は後段処理にある。
- PR #28105 の `GPUQueue.copyExternalImageToTexture` は「描画/転送時に変換を適用する」方向の設計が含まれている。

## スコープ
### 取り込む範囲
- `ext/image` の `createImageBitmap` 実装を遅延化（段階1）。
- `ImageBitmap` の内部表現を Lazy 化し、消費側で materialize 可能にする。
- Deno 内部で提供される描画 API（例: `GPUQueue.copyExternalImageToTexture`）で materialize を実行。

## 非目標
- `createImageBitmap` の reject タイミングを遅らせない（段階1）。
- 互換性を犠牲にした挙動差分の導入。
- すべての描画経路での GPU 依存の最適化。
- **段階1では** `bitmap task source` 仕様対応（global task queue への settle 経路変更）を必須化しない。
  - この対応は別タスクとして段階導入する。

## 実装方針（段階1）
### 基本方針
- **decode は即時**で維持し、reject タイミングは変えない。
- **後段処理（crop / resize / orientation / color space / premultiply）を遅延**する。
- 遅延処理は `ImageBitmap::materialize()` で統一。

### Lazy 化の形
- `ImageBitmap` の内部を `Decoded` と `Lazy` の2形態で保持する。
- `Lazy` が保持する最小情報:
  - `width` / `height`
  - `imageOrientation`
  - `colorSpaceConversion`
  - `premultiplyAlpha`
  - `resizeQuality` / `resizeWidth` / `resizeHeight`
  - crop 情報（`sx` / `sy` / `sw` / `sh`）
  - デコード済みピクセル（段階1では保持）

### materialize の責務
- 遅延されている処理を仕様順序で適用:
  1. crop
  2. resize
  3. orientation
  4. color space conversion
  5. premultiply / unpremultiply
- 変換結果は `Decoded` としてキャッシュし、再利用可能にする。
- `close()` でキャッシュを破棄する。

### 責務分離（materialize vs 消費側）
- `materialize()` の責務:
  - CPU 参照が必要な経路（`getData()` など）で、仕様順序どおりの確定済み画素を提供する。
  - 一度確定した結果を再利用し、再計算を避ける。
- 消費側 API（例: `copyExternalImageToTexture`）の責務:
  - fast-path 判定を先に行う。
  - 変換不要なら確定済みデータを最短経路で利用。
  - 変換が必要なら transform-path を選択（段階1では materialize 経由、将来は GPU 変換の余地を残す）。

### materialize 実装の考慮点（CPU パス）
- GPU が使えない／使わない場合でも成立するよう、**CPU パスの変換を前提**に設計する。
- CPU パスでは `readPixels` 相当のコストが高いため、**materialize の再実行を避ける**（Decoded への昇格キャッシュを必須とする）。
- CPU パスでの色変換・premultiply は既存 `image`/`image_ops` の処理で完結できる設計にする。

### materialize 実装の考慮点（GPU パス・将来）
- GPU ターゲットへの直接描画/転送経路では、CPU 変換を経由せず GPU で transform を適用できる余地がある。
- ただし `getData()` / `convertToBlob` のような CPU 参照が必要な経路では readback コストが支配的なため、GPU パスを強制しない。
- 将来の GPU fast path 追加に備え、`materialize()` は CPU パスの共通実装として維持する（消費側で分岐させる）。

## 消費側のトリガー（段階1）
- `Deno[Deno.internal].getBitmapData`（テスト用途）
- `GPUQueue.copyExternalImageToTexture`（PR #28105 相当）
- 将来的に `CanvasRenderingContext2D.drawImage` 相当が導入される場合は同様に materialize を使う。

### `copyExternalImageToTexture` の fast-path 方針（段階1）
- 目的: 変換不要ケースでは最短経路で転送し、不要な CPU 変換を避ける。
- fast-path の候補条件（すべて満たす場合）:
  - `flipY == false`
  - `premultipliedAlpha` の変更が不要（入力状態と要求状態が一致）
  - `colorSpace` 変換が不要
  - crop が実質 full-range（追加の切り出し不要）
  - `copySize` / `origin` がそのまま転送可能
- 上記のいずれかを満たさない場合は transform-path にフォールバックする。
- 備考:
  - 将来的な GPU fast-path（オンザフライ変換）導入時も、まずこの判定を入口にする。

## 構造変更（想定）
- `ImageBitmap` を `Decoded` / `Lazy` に分ける enum で保持。
- `getData()` と `copyExternalImageToTexture` で `materialize()` を呼び出す。
- `createImageBitmap` は `DynamicImage` を作成し、遅延処理情報を `Lazy` として保持。

## 互換性・エラー設計
- `sw/sh == 0` や `resizeWidth/resizeHeight == 0` は現行通り即時 reject。
- decode の失敗は `createImageBitmap` の Promise で reject（段階1で維持）。
- `materialize` は `close()` 済みの場合にエラーを返す。

### エラー責務境界（段階1）
- `createImageBitmap` 側で確定させるもの:
  - 引数バリデーション由来の失敗
  - デコード不能など「画像生成そのものの成立」に関わる失敗
- `materialize` / 消費側で扱うもの:
  - `close()` 後アクセスなどライフサイクル由来の失敗
  - 遅延処理の実行時にのみ発生し得る内部失敗（必要に応じて消費 API のエラーへ写像）
- 方針:
  - 互換性重視のため、`createImageBitmap` で確定可能な失敗は可能な限り前倒しで確定する。

## テスト計画
- 既存 `tests/unit/image_bitmap_test.ts` は維持。
- 追加テスト（段階1）:
  - `createImageBitmap` が resolve するが `getData()` で materialize が動くこと。
  - `copyExternalImageToTexture` が materialize 後のデータを使うこと。
  - `close()` 後に消費 API を呼んだ場合のエラー確認。
  - 同一 `ImageBitmap` を複数回消費した際、2回目以降で再materializeせずキャッシュが使われること。
  - `copyExternalImageToTexture` の fast-path 条件を満たすケースで transform-path に落ちないこと（回帰防止）。

## リスクと緩和
- **互換性差分**: decode 即時を維持することで回避。
- **キャッシュメモリ**: materialize 後のキャッシュは `close()` で明示破棄。
- **Deno外部ライブラリ**: Deno内部 API に限定して遅延を適用し、外部は現状維持。

## Serializable/Transferable の現状と将来対応
- 現状の Deno では `ImageBitmap` は host object として扱われず、`structuredClone` の結果は `{}` になる（`img-clone.js`）。
- `postMessage` の transferables に渡すと `DataCloneError` になる（`img-transfer.js`）。
- 将来的に対応する場合は、`materialize()` を境界に「serialize 時に確定化」または「Lazy 情報を再現可能な形で転送」のいずれかを選べる設計にする。
- transfer 時の detach/close の意味は現在の `close()` と整合させる。

## 段階2以降（将来検討）
- ヘッダ解析のみで `width/height` を確定し decode を遅延。
- reject タイミング差分の互換性評価と文書化。
- GPU ターゲット経路に限定した transform の GPU fast path（readback 不要な場合にのみ適用）。
- GPU 側での色変換や premultiply のオンザフライ最適化。

## 進め方（作業順序）
1. `ImageBitmap` の内部表現を `Decoded` / `Lazy` に分離。
2. `materialize()` を実装し、後段処理を集約。
3. `getData()` と `copyExternalImageToTexture` を materialize 経由に変更。
4. 既存テストを通し、新規テスト追加。
5. 性能と互換性の評価メモを更新。

## 実装タスク（チケットレベル）
### T1: `ImageBitmap` の Lazy 表現追加
- 目的: `Decoded` / `Lazy` の2形態を導入し、後段処理を遅延可能にする。
- 主な作業:
  - `ImageBitmap` 内部を enum で保持。
  - `Lazy` に必要なメタ情報を保持（crop/resize/色変換/premultiply）。
- 完了条件:
  - `ImageBitmap` が Lazy を保持できる。
  - `width/height` は既存通り取得可能。

### T2: `materialize()` 実装
- 目的: 遅延処理を仕様順序で適用し、`Decoded` に昇格させる。
- 主な作業:
  - crop → resize → orientation → color space → premultiply を順に適用。
  - materialize 後のキャッシュ方針を実装（Decoded へ昇格）。
- 完了条件:
  - materialize の再実行で再計算せず、同一結果を返す。

### T3: `createImageBitmap` の生成処理変更
- 目的: decode を即時に行いつつ、後段処理を Lazy に移す。
- 主な作業:
  - decode を `createImageBitmap` 内で維持。
  - 後段処理を materialize に移管。
- 完了条件:
  - 破損画像の reject タイミングが変わらない。

### T4: 消費側 API の materialize 化
- 目的: 描画/転送時に後段処理を適用する。
- 主な作業:
  - `getData()` で materialize を呼び出す。
  - `GPUQueue.copyExternalImageToTexture`（PR #28105 相当）で materialize を呼び出す。
  - `copyExternalImageToTexture` に fast-path / transform-path の分岐を導入する。
- 完了条件:
  - Lazy 状態の `ImageBitmap` を消費しても正しいデータが取得できる。
  - fast-path 条件を満たすケースで不要な変換処理を回避できる。

### T5: テスト追加・更新
- 目的: 遅延化による挙動差分を検出。
- 主な作業:
  - `getData()` が materialize を引き起こすことを検証。
  - `close()` 後の消費 API エラーを検証。
  - 同一 `ImageBitmap` の複数回消費でキャッシュ再利用されることを検証。
  - fast-path 条件時に transform-path へ不要フォールバックしないことを検証。
- 完了条件:
  - 既存テストが通り、新規テストが追加される。

### T6: `createImageBitmap` settle 経路の抽象化
- 目的: Promise settle の実装詳細を `createImageBitmap` 本体から分離し、直接 settle / task 経由 settle を切替可能にする。
- 主な作業:
  - `createImageBitmap` の成功・失敗返却を単一の settle ヘルパー経由に統一。
  - 直接 settle 実装と task 経由実装を差し替え可能な境界を作る。
- 完了条件:
  - `createImageBitmap` 本体が settle 方法に依存しない構造になる。
  - 既存挙動（段階1: 直接 settle）を維持したままテストが通る。

### T7: bitmap task source 対応（core / event loop）
- 目的: `createImageBitmap` の resolve/reject を bitmap task source（global task queue）経由で実行する。
- 主な作業:
  - イベントループ側に bitmap 用タスクキュー（または task source 種別）を導入。
  - 該当フェーズでの drain 実行を追加。
  - `createImageBitmap` の settle を enqueue に切替。
- 完了条件:
  - resolve / reject の双方が bitmap task source を経由する。
  - 順序テスト（microtask / 他タスクとの相対順）を追加して通過する。

## 差分ベースの TODO リスト
- `ext/image/bitmap.rs`
  - `ImageBitmap` を `Decoded` / `Lazy` に分離。
  - `materialize()` 追加（遅延処理を集約）。
  - `op_create_image_bitmap` の後段処理を materialize に移管。
  - `getData()` が materialize 経由でデータ取得するよう変更。
- `ext/webgpu/queue.rs`（PR #28105 の実装相当）
  - `copyExternalImageToTexture` で materialize を呼び出す。
- `tests/unit/image_bitmap_test.ts`
  - Lazy 状態での `getData()` / `close()` の挙動を追加検証。
  - （T6/T7）settle 経路の抽象化に伴う回帰がないことを検証。
  - （T7）task 経由 settle の順序検証（microtask との相対順）を追加。
- `libs/core/event_loop.rs` / `libs/core/runtime/jsruntime.rs`
  - （T7）bitmap task source 実装時に、enqueue / drain とフェーズ組み込みを追加。

## 参考
- PR: https://github.com/denoland/deno/pull/28105
- `static_bitmap_image_transform.cc`（Chromium の transform パス）
