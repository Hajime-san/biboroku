// transfer via MessageChannel: transferables に渡せるか
const { port1, port2 } = new MessageChannel();
port2.onmessage = (e) => {
  console.log("received:", e.data);
};

try {
  const bmp = await createImageBitmap(new ImageData(1, 1));
  port1.postMessage(bmp, [bmp]);
  console.log("postMessage transfer ok");
} catch (e) {
  console.log("postMessage transfer error:", e?.name, e?.message);
}

// 現状: ImageBitmap は Transferable 未対応のため DataCloneError になる。
