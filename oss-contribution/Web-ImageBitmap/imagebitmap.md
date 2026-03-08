# imagebitmap: 中央まとめ

このファイルは、`createImageBitmap` の遅延化に関する計画・調査・実装計画を一元的に参照するための目次である。
詳細は以下の4ファイルに記載されている。

## 参照ドキュメント
- 計画: `plan-lazy-imagebitmap.md`
- 調査: `survey-lazy-imagebitmap.md`
- 調査（task queue）: `survey-task-queue-imagebitmap.md`
- 実装計画: `impl-lazy-imagebitmap.md`

## 現状の結論（要約）
- 互換性を維持するため、**decode は即時**で行う（reject タイミングを維持）。
- **後段処理（crop/resize/方向補正/色変換/premultiply）は遅延可能**。
- 遅延処理は `ImageBitmap::materialize()` に集約する方針。
- 描画/転送時（例: `GPUQueue.copyExternalImageToTexture`）に materialize を実行する設計が妥当。

## 実装計画の入口
- 具体的な設計・タスク分解は `impl-lazy-imagebitmap.md` を参照。
- PR #28105 の `copyExternalImageToTexture` 実装は `survey-lazy-imagebitmap.md` で整理済み。

## 次に作業を再開する場合の手順
1. `impl-lazy-imagebitmap.md` の「実装タスク（チケットレベル）」を確認。
2. `impl-lazy-imagebitmap.md` の「差分ベースの TODO リスト」に沿って作業。
3. 追加の調査や判断が必要な場合は `survey-lazy-imagebitmap.md` を確認。

## 関連リンク
- PR: https://github.com/denoland/deno/pull/28105
- 仕様: https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#dom-createimagebitmap-dev
