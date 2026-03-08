# createImageBitmapの処理を遅延する

## 概要

[仕様](https://html.spec.whatwg.org/multipage/imagebitmap-and-animations.html#dom-createimagebitmap-dev)では、`createImageBitmap`は`width`と`height`および`close`をユーザーに返却する。
実態としての`[[BitmapData]]`はユーザーからはアクセスできないようなAPI設計になっている。これの仕様は意図されたもので、`ImageBitmap`を受け取って描画する[`CanvasRenderingContext2D.drawImage()`](https://html.spec.whatwg.org/multipage/canvas.html#dom-context-2d-drawimage-dev)などの別のAPIの描画実行時に画像処理を遅延させることができるという余白を生んでいる。

そこで、現在`ext/image`配下に実装されている`createImageBitmap`の画像処理を可能な限り遅延させることが出来ないかを検討する。

## 要件

- 公式仕様から逸脱しないこと。
  例えばエラーを返すべきである`If either sw or sh is given and is 0, then return a promise rejected with a RangeError.`という指示は画像処理を必要としない。このような処理を遅延させてしまうと、ユーザーにとって破壊的変更となる。
- 破壊的変更とならないこと。
  サードパーティーライブラリが描画に`createImageBitmap`を用いる場合、その内部`[[BitmapData]]`にアクセスできない以上、そもそもこのAPIは描画までランタイムが一貫して責務を持つ必要があるため、考えなくてよい。
- パフォーマンスを追求すること。
- GPU実装パスの余地を残すこと。

## 調査するべきこと

- 具体的にどのような画像処理が遅延可能なのか。最終的な描画処理がGPUで行われる場合、画像のデコードなども施さずに、全てGPU上で処理するのが最も効率がいいのか。
- CPUレンダリングの可能性も考慮して、既存の画像処理と共存可能か。

## リファレンス

- `ext/image`
- `tests/unit/image_bitmap_test.ts`

`ImageBitmap`を受け取る`GPUQueue.copyExternalImageToTexture
`の実装。
https://github.com/denoland/deno/pull/28105

## タスクキュー

最近仕様に入った、> Queue a global task, using the bitmap task source, to resolve promise with imageBitmap. という記述がある。
https://github.com/whatwg/html/pull/11327
https://github.com/whatwg/html/issues/5329
https://github.com/whatwg/html/issues/10611

Geckoはこの仕様に準拠する挙動を実装している。
https://searchfox.org/firefox-main/rev/69ee52c76f3d3b3c0e8433cd9cdc153255988738/xpcom/threads/TaskCategory.h#36-37
https://searchfox.org/firefox-main/rev/69ee52c76f3d3b3c0e8433cd9cdc153255988738/dom/canvas/ImageBitmap.cpp#1173-1188

## 備考

Denoにおける`createImageBitmap`はオリジンを考慮する必要はない。また、必要であれば同一のAPIを提供するブラウザの実装なども参考にすること。
