## 概要

[仕様](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#dom-createimagebitmap-dev)では、`createImageBitmap` は `width` と `height` および `close` をユーザーに返却する。
実態としての `[[BitmapData]]` はユーザーからは直接アクセスできないAPI設計であり、`CanvasRenderingContext2D.drawImage()` などの消費側APIで、後段処理を適用する設計余地がある。

本ドキュメントでは、`ext/image` 配下の `createImageBitmap` 実装において、互換性を維持しつつ、**作成時 decode / 利用時に後段処理適用**の処理モデルを検討する。

## 要件

- 公式仕様から逸脱しないこと。
  例: `If either sw or sh is given and is 0, then return a promise rejected with a RangeError.` のような判定は、画像処理を待たず即時に扱う。
- 破壊的変更とならないこと。
- パフォーマンスを追求すること。
- GPU実装パスの余地を残すこと。

## 調査するべきこと

- どの画像処理を作成時に行い、どの処理を利用時に適用するのが妥当か。
- 最終描画がGPUの場合、どの処理をGPU側に委ねると効率的か。
- CPUレンダリング経路と共存できる構造か。

## リファレンス

- `ext/image`
- `tests/unit/image_bitmap_test.ts`

`ImageBitmap` を受け取る `GPUQueue.copyExternalImageToTexture` の実装。
https://github.com/denoland/deno/pull/28105

## タスクキュー

仕様に以下の記述がある。
> Queue a global task, using the bitmap task source, to resolve promise with imageBitmap.

- https://github.com/whatwg/html/pull/11327
- https://github.com/whatwg/html/issues/5329
- https://github.com/whatwg/html/issues/10611

Geckoはこの仕様に準拠する挙動を実装している。

- https://searchfox.org/firefox-main/rev/69ee52c76f3d3b3c0e8433cd9cdc153255988738/xpcom/threads/TaskCategory.h#36-37
- https://searchfox.org/firefox-main/rev/69ee52c76f3d3b3c0e8433cd9cdc153255988738/dom/canvas/ImageBitmap.cpp#1173-1188

## 備考

Denoにおける `createImageBitmap` はオリジン考慮が不要。必要に応じて同等APIを提供するブラウザ実装も参照する。```
