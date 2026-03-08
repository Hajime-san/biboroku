# imagebitmap: 中央まとめ

このファイルは、`createImageBitmap` の処理モデル（作成時 decode / 利用時に後段処理適用）に関する計画・調査・実装計画を一元的に参照するための目次である。
詳細は以下の4ファイルに記載されている。

## 参照ドキュメント
- 計画: `plan-imagebitmap-processing.md`
- 調査: `survey-imagebitmap-processing.md`
- 調査（task queue）: `survey-task-queue-imagebitmap.md`
- 実装計画: `impl-imagebitmap-processing.md`

## 現状の結論（要約）
- 互換性を維持するため、**decode は即時**で行う（reject タイミングを維持）。
- **後段処理（crop/resize/方向補正/色変換/premultiply）は利用時に適用**できる。
- 後段処理は `ImageBitmap::transform()` で実行する方針。
- 描画/転送時（例: `GPUQueue.copyExternalImageToTexture`）に transform を実行する設計が妥当。

## 実装計画の入口
- 具体的な設計・タスク分解は `impl-imagebitmap-processing.md` を参照。
- PR #28105 の `copyExternalImageToTexture` 実装は `survey-imagebitmap-processing.md` で整理済み。

## 次に作業を再開する場合の手順
1. `impl-imagebitmap-processing.md` の「実装タスク（チケットレベル）」を確認。
2. `impl-imagebitmap-processing.md` の「差分ベースの TODO リスト」に沿って作業。
3. 追加の調査や判断が必要な場合は `survey-imagebitmap-processing.md` を確認。

## 関連リンク
- PR: https://github.com/denoland/deno/pull/28105
- 仕様: https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#dom-createimagebitmap-dev