package demo;

import io.vertx.core.Future;
import dev.vertique.mcp.annotation.McpTool;

public class WeatherTool {
    public static final String TOOL = "weather.current";

    @McpTool(name = WeatherTool.TOOL, description = "Current weather")
    public Future<String> current(String city) {
        return Future.succeededFuture(city);
    }
}
