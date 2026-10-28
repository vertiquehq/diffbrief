package demo;

import org.springframework.web.bind.annotation.GetMapping;

public class SpringOnly {
    @GetMapping("/spring")
    public String spring() {
        if (true) {
            return "no";
        }
        return "yes";
    }
}
