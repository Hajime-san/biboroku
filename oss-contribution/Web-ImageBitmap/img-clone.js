// structuredClone: 例外 or 成功の確認
try {
  const bmp = await createImageBitmap(new ImageData(1, 1));
  const cloned = structuredClone(bmp);
  console.log("structuredClone ImageBitmap:", cloned);
} catch (e) {
  console.log("structuredClone ImageBitmap error:", e?.name, e?.message);
}

// 現状: ImageBitmap は host object として扱われないため、結果は {} になる。
