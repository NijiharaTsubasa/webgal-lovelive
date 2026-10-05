# 引擎回归测试

安装仓库依赖后，在仓库根目录执行 `yarn test`，一次运行 parser 测试和引擎回归测试。PR 检查使用相同命令，任一测试失败都会使检查失败。

单独运行引擎测试使用 `yarn webgal:test`；在 `packages/webgal` 目录也可以执行 `yarn test`。单独运行 parser 测试使用 `yarn parser:test --run`。

引擎测试使用 Node.js 内置测试工具，自动发现本目录下的 `*.test.cjs` 文件。测试通过项目已有的 TypeScript 编译器加载源码，并为 DOM、Pixi 和资源加载等依赖提供测试替身。新增测试放入本目录即可纳入统一入口。

这些测试验证状态演算、资源准备、角色生命周期及配置行为。实际 WebGL 显示效果和录屏性能需要单独进行浏览器验证。
