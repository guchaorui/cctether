# 上架 Chrome 应用商店：每一格放什么

给主人对照着商店后台（开发者信息中心）一格一格填。图片都在 `store/images/` 里。

**怎么把图片弄到 Mac 上**：打开 https://github.com/guchaorui/cctether ，点绿色的 **Code** → **Download ZIP**，解压后进 `store/images` 文件夹，要用哪张就把哪张拖进后台对应的格子。

## 软件包

上传 Release 页面里的 **`cctether-extension-<版本号>-store.zip`**（名字里带 `-store` 的那个）：https://github.com/guchaorui/cctether/releases

## 商品详情 → 图片资源

| 后台里的格子 | 放这个文件 | 尺寸 |
|---|---|---|
| 商店图标 | `store-icon-128.png` | 128×128 |
| 全球通用的屏幕截图 | `screenshot-1-en.png`、`screenshot-2-en.png`、`screenshot-3-en.png`（按这个顺序） | 1280×800 |
| 全球通用的小型宣传图块 | `promo-small-en.png` | 440×280 |
| 全球通用的顶部宣传图块（可不填） | `marquee-en.png` | 1400×560 |
| 以当地语言显示的屏幕截图（页面上方语言选「中文（简体）」时） | `screenshot-1-zh.png`、`screenshot-2-zh.png`、`screenshot-3-zh.png` | 1280×800 |
| 以当地语言显示的小型宣传图块（同上，中文） | `promo-small-zh.png` | 440×280 |
| 以当地语言显示的顶部宣传图块（同上，中文，可不填） | `marquee-zh.png` | 1400×560 |

- 「全球通用」的放英文版：看不到中文的用户看到的是它。
- 选「English」那一页时，「以当地语言显示」的格子可以空着（会用全球通用的英文图），也可以再放一遍英文版。
- 所有截图和宣传图都是 24 位 PNG、没有透明层，符合后台的要求。商店图标按商店的图片规范，图案 96×96、四周留 16 像素透明边。
- 宣传视频不用填。

## 文字

- 商品详情（名称、简介、详细说明、类别、语言）、隐私权规范（单一用途、每个权限的理由、远程代码、数据使用、隐私政策网址）、分发：照 [listing.md](listing.md)（英文，后台要填英文）逐项复制。
- 中文的商品详情（页面上方语言切到「中文（简体）」后填）：照 [listing.zh-CN.md](listing.zh-CN.md)。那个文件后半部分还用中文解释了隐私权规范每一项是什么意思、为什么这么答。

## 填完以后

先点「保存草稿」，确认右上角「我为何无法提交？」里没有问题了，再点「提请审核」。
