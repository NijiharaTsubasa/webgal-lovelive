# 角色加载提示样式

在 `game/template/UI/CharacterLoading/characterLoading.scss` 中配置加载提示。样式文件通过主题加载器读取，也支持主题样式重载。

| 类名 | 用途 |
| --- | --- |
| `.CharacterLoading_sceneIndicator` | 整场景加载提示的位置、对齐和变换 |
| `.CharacterLoading_sceneImage` | 整场景加载图片的地址、尺寸和背景显示方式 |
| `.CharacterLoading_stageIndicator` | 单句加载提示的位置、对齐和变换 |
| `.CharacterLoading_stageImage` | 单句加载图片的地址、尺寸和背景显示方式 |
| `.CharacterLoading_error` | 加载失败文字 |
| `.CharacterLoading_retry` | 重试按钮 |

每个主题类的规则完整替换该类的默认样式；未提供的类使用内置样式。加载时的暗化与操作拦截由播放器控制。

整场景加载和单句加载有独立的图片槽位，可以分别使用不同素材和尺寸。图片使用 `background-image` 指定，支持 PNG、GIF 和动态 WebP；动图按图片自身的帧序列播放。资源 URL 相对于游戏页面解析，例如 `url('game/template/assets/loading.gif')`。调整图片时，请同步设置 `width`、`height` 和 `background-size`。

播放器提供两个以舞台像素为单位的 CSS 变量：`--character-loading-anchor-x` 是对话框右边缘，`--character-loading-anchor-y` 是对话框下边缘。默认提示向左对齐右边缘，显示在下边缘外侧 8 像素处。

主题可以沿用锚点调整偏移，也可以直接使用 `left`、`top`、`right`、`bottom` 和 `transform` 设置固定位置，例如：

```scss
.CharacterLoading_stageIndicator {
  position: absolute;
  right: 80px;
  bottom: 20px;
  text-align: right;
}

.CharacterLoading_stageImage {
  width: 300px;
  height: 40px;
  background: url('game/template/assets/loading.gif') center / contain no-repeat;
}
```
