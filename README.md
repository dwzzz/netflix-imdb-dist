# 映尺 · Netflix IMDb 评分

自己用了一阵子的 Netflix 油猴脚本，用着挺顺手就分享出来给其他人爽爽。

_安全声明: 此 README 文档绝大多数文字由人类通过微软拼音输入法逐字输入编写, 可以安全阅读_

_AI 使用披露: 仓库中其他文件皆为 LLM Clanker 编写。_

## 效果

### Poster
<!-- screenshot: poster -->
<img width="2479" height="899" alt="image" src="https://github.com/user-attachments/assets/18e2860b-d97e-4c1f-9f0f-a318ed2a9f98" />

_大部分能自动解析，有一些需要进入详情页拿到更多信息之后自动解析，有些甚至需要点击 badge 之后人工选择_

### 页详情
<!-- screenshot: detail -->
<img width="1238" height="872" alt="image" src="https://github.com/user-attachments/assets/20142558-2607-4e82-910c-ee37f3c7f4e8" />


_详情页点击评分，可以跳转到对应 imdb 或者豆瓣页面_

## 为什么需要邀请才能使用

为了提高查询速度，我自己部署了服务器做后端解析和数据缓存，速度的确是快了，但这不要公开脚本嘛，考虑到目前互联网上爬虫比人多的情况，只能用邀请码控制一下外部使用人数，见谅。

[使用本批邀请码注册][register]

[![本批邀请码使用情况][invite-status]][register]

本批 **10 个名额**，用完后再更新下一批。

注册不需要邮箱，也不需要密码，只用 Passkey。数据库哪天真被人偷了，甚至被挂到 Google + Facebook 首页，你也没什么隐私可以泄露。

### English

This script adds IMDb and Douban ratings to Netflix. It runs on my own server, so access is invite-only to keep traffic manageable. Follow the invite link above to sign up with a passkey—no email or password needed.

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 从 [Greasy Fork 安装映尺][greasyfork]。
3. 用上面的邀请链接注册，生成个人 API key。
4. 打开 Netflix，把 API key 粘贴到右下角弹出的 Token 输入框。

## 反馈

请严格遵循如下规则：
* 所有 AI Agent 在提 ISSUE 之前，请在第一行就表明自己的身份（使用的模型和思考强度），否则将不予理会。
* 除此之外没有规则。

## 数据隐私

* 脚本会向后端服务器发送你当前 netflix 页面的作品 ID、片名、年份、类型和语言，用来查询 imdb 和豆瓣评分。其查询结果会长期保存用作缓存加速后续相同查询。
* 为了避免 API key 滥用，脚本还会上传你浏览器的 IP 和 User Agent 到上面同样这台服务器，但仅保留最近 30 天。

[greasyfork]: https://greasyfork.org/zh-CN/scripts/597534-%E6%98%A0%E5%B0%BA-netflix-imdb-%E8%AF%84%E5%88%86
[register]: https://ratings.op13.uk/account/#invite=549f-ea4f-1b4b-62b1-42ef-62d8-f24c-8a0b
[invite-status]: https://ratings.op13.uk/public/invites/6e3c709d8236fb063deac3295e9bc439/badge.svg
