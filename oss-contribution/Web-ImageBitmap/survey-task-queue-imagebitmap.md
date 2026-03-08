# survey: createImageBitmap の bitmap task source 対応調査

## 目的
- `createImageBitmap` の Promise settle を、仕様で要求される **global task（bitmap task source）** に合わせる場合の実装影響を整理する。
- 既存の遅延変換計画（`impl-lazy-imagebitmap.md`）と、イベントループ側変更を分離実装できるようにする。

## 参照
- WHATWG HTML:
  - `Queue a global task, using the bitmap task source, to resolve promise with imageBitmap.`
- 変更議論:
  - https://github.com/whatwg/html/pull/11327
  - https://github.com/whatwg/html/issues/5329
  - https://github.com/whatwg/html/issues/10611
- 実装計画:
  - `impl-lazy-imagebitmap.md`

---

## 調査サマリ（Deno core 観点）

### 1) 現在の `libs/core` 側の状況（要点）
- `libs/core/event_loop.rs` は補助的な phase 状態を持つ設計で、現状は主に close callback キューを扱う。
- 実際のイベントループ駆動は `libs/core/runtime/jsruntime.rs` 側（`poll_event_loop_inner`）で行われる前提。
- `bitmap task source` に直接対応する構造（専用 task source / 専用キュー）は、調査時点では確認できない。

### 2) そのため必要になりうる変更
- **イベントループに task source 概念を追加**するか、
- 既存タスク実行枠に **bitmap 用キュー**を追加して順序保証を与える必要がある。

---

## 実装変更の候補（最小差分案）

### A. core 側（イベントループ）
1. `EventLoopPhases` に bitmap 用キューを追加
   - 例: `bitmap_tasks: VecDeque<...>`
2. enqueue API を追加
   - 例: `queue_bitmap_task(...)`
3. drain API を追加
   - 例: `run_bitmap_tasks(...)`
4. `poll_event_loop_inner` に実行フェーズを組み込み
   - どのフェーズで実行するか（順序）を固定化

### B. `createImageBitmap` 側
1. Promise の直接 settle を避ける
2. 成功/失敗の settle を bitmap task として enqueue
3. task 実行時に resolve/reject を実行

### C. テスト
1. settle タイミングが「即時」ではなく task 経由であること
2. microtask / 他 task との順序整合
3. resolve/reject の両経路が同一 task source を通ること

---

## 期待メリット
- **仕様準拠**: settle タイミングを標準の task source モデルに合わせやすい。
- **順序安定化**: image 系完了通知の順序を一元管理できる。
- **将来拡張**: image 系 API の完了通知を同じ仕組みに載せられる。

## パフォーマンス影響（見込み）
- 追加の enqueue/dequeue による **微小オーバーヘッド**はある。
- decode/変換コストに比べると影響は小さい可能性が高い。
- 実効的には「レイテンシがわずかに増える代わりに、順序と互換性が安定する」トレードオフ。

---

## 遅延変換実装との結合可能性

### 結論
- **分離実装しやすい**。どちら先行でも結合可能。

### 前提（重要）
- `createImageBitmap` の settle 経路を薄い抽象に切り出すこと。
  - 例: `settle_create_image_bitmap(result)` 相当
- この層の内部を
  - 直接 settle 実装
  - bitmap task 経由実装
 で差し替え可能にする。

### 推奨順序
1. 先に遅延変換（`Lazy` + `materialize()`）を導入
2. 後から settle 経路を bitmap task source 化

理由: 不具合切り分けが容易で、互換性差分の検証ポイントを分離しやすい。

---

## 実装時の論点（未決定事項）
- bitmap task を専用キューで持つか、汎用キューに source 種別を持たせるか
- 実行順序（他フェーズとの相対順）
- 1 tick あたり処理件数（starvation 回避）
- runtime/isolate 境界でのキュー所有モデル

---

## `impl-lazy-imagebitmap.md` への連携追記（提案）

以下を `impl-lazy-imagebitmap.md` に追記する。

### 追記案1: 非目標の明確化
- 段階1では task source 仕様変更を必須化しない（別タスクで段階導入）。

### 追記案2: 実装タスク（チケット）追加
- **T6: createImageBitmap settle 経路の抽象化**
  - 目的: 直接 settle / task 経由 settle を切替可能にする。
  - 完了条件: `createImageBitmap` 本体から settle 実装詳細を分離。

- **T7: bitmap task source 対応（core/event loop）**
  - 目的: Promise settle を bitmap task source 経由で実行。
  - 主な作業:
    - `libs/core` に bitmap task キュー導入
    - `poll_event_loop_inner` に drain フェーズ導入
    - `createImageBitmap` から enqueue
  - 完了条件:
    - resolve/reject の双方が bitmap task source を経由
    - 順序テストが通る

### 追記案3: テスト項目追加
- `createImageBitmap` の settle が task 経由であることを検証
- microtask との順序（回帰テスト）
- 連続 `createImageBitmap` 呼び出し時の順序安定性

---

## 最終結論
- `bitmap task source` 対応は、`libs/core` のイベントループ構造に **専用キュー/実行フェーズ**を追加する変更が中心。
- 遅延変換（`materialize()`）と実装フェーズを分離して進めることは十分可能。
- 先に settle 経路を抽象化しておけば、後から core 側を実装しても低リスクで結合できる。