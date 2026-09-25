# 映尺 · Netflix IMDb 评分

自己用了一阵子的 Netflix 油猴脚本，自己用着觉得挺顺手，就分享出来给其他人试试。

## 效果

### Poster
<!-- screenshot: poster -->
_截图待补_

### 小详情
<!-- screenshot: mini-detail -->
_截图待补_

### 大详情
<!-- screenshot: detail -->
_截图待补_

## 邀请体验

为了让查询尽量快，我自己部署了服务器做解析和数据缓存。这个小服务器是我自己的，性能有限，我有点担心完全公开后被脚本或爬虫滥用，所以暂时用邀请码控制一下外部使用人数，见谅。

[使用本批邀请码注册][register]

[![本批邀请码使用情况][invite-status]][register]

本批 **10 个名额**，用完后我会更新下一批。

注册不需要邮箱，也不需要密码，只用 Passkey。数据库哪天真被人偷了，甚至被挂到 Google + Facebook 首页，你也没什么隐私可以泄露。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 安装 `netflix-imdb.user.js`。
3. 用上面的邀请链接注册，拿到个人 API key。
4. 打开 Netflix，把 API key 粘贴到脚本的 Token 输入框。

## 反馈

我对目前 Netflix → IMDb / 豆瓣的解析能力还没有完全放心。电影、剧集、季度和整剧之间有不少边角情况，这也是我把它分享出来的一点小心思。

如果遇到明显错配、该有结果却一直没有、豆瓣链接错误，或任何看起来奇怪的情况，欢迎开 [Issue](https://github.com/dwzzz/netflix-imdb-dist/issues)。真实样本会很有助于我继续完善解析。

## 数据

脚本会向 `ratings.op13.uk` 发送作品 ID；详情匹配时可能额外发送片名、年份、类型和语言。
为了避免 API key 滥用，还会上传你浏览器的 IP 和 User Agent。但仅保留最近 30 天，毕竟个人服务器磁盘寸土寸金。
本项目不是 Netflix、IMDb 或豆瓣官方产品。

[register]: https://ratings.op13.uk/account/#invite=549f-ea4f-1b4b-62b1-42ef-62d8-f24c-8a0b
[invite-status]: https://ratings.op13.uk/public/invites/6e3c709d8236fb063deac3295e9bc439/badge.svg
