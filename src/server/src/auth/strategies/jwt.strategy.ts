import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import { IUser, JWTPayload } from "../../../../shared/entities";
import { UsersService } from "../../users/services/users.service";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly usersService: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || ""
    });
  }

  async validate(payload: JWTPayload): Promise<IUser> {
    const user = await this.usersService.findOne({ where: { id: payload.id } });
    if (!user) {
      throw new UnauthorizedException();
    }
    return payload;
  }
}
