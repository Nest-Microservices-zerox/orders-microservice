import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderDto } from './dto/update-order.dto';
import { PrismaService } from 'src/prisma.service';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { OrderPaginationDto } from './dto/order-pagination.dto';
import { ChangeOrderStatusDto } from './dto';
import { NATS_SERVICE } from 'src/config';
import { firstValueFrom } from 'rxjs';
import { OrderWithProducts } from './interfaces/order-with-products.interface';
import { PaidOrderDto } from './dto/paid-order.dto';

@Injectable()
export class OrdersService {

  private readonly logger = new Logger('OrdersService');

  constructor(
    private prisma: PrismaService,
    @Inject(NATS_SERVICE) private readonly client: ClientProxy
  ) {}

  async create(createOrderDto: CreateOrderDto) {

    try {

      // 1. Confirmar ids de los products
      const productIds = createOrderDto.items.map( item => item.productId);
      const products: any[] = await firstValueFrom(
        this.client.send({cmd: 'validate_product'}, productIds)
      );

      // 2. Cálculos de los valores
      const totalAmount = createOrderDto.items.reduce( (acc, orderItem ) => {
        const price = products.find( 
          (product) => product.id === orderItem.productId
        ).price

        return price * orderItem.quantity;
      }, 0);

      const totalItems = createOrderDto.items.reduce((acc, orderItem) => {
        return acc + orderItem.quantity;
      }, 0);

      // 3. Crear una transacción de base de datos
      const order = await this.prisma.order.create({
        data: {
          totalAmount: totalAmount,
          totalItems: totalItems,
          OrderItem: {
            createMany: {
              data: createOrderDto.items.map( (orderItem) => ({
                price: products.find( product => product.id === orderItem.productId ).price,
                productoId: orderItem.productId,
                quantity: orderItem.quantity
              }))
            }
          }
        },
        include: {
          OrderItem: {
            select: {
              price: true,
              quantity: true,
              productoId: true,
            }
          }
        }
      });

      return {
        ...order,
        OrderItem: order.OrderItem.map( (orderItem) => ({
          ...orderItem,
          name: products.find( (product) => product.id === orderItem.productoId).name
        }))
      };
      
    } catch (error) {
      throw new RpcException({
        status: HttpStatus.BAD_REQUEST,
        message: error
      })
    }

  }

  async findAll(orderPaginationDto:OrderPaginationDto) {
    
    const totalPages = await this.prisma.order.count({
      where: {
        status: orderPaginationDto.status
      }
    });

    const currentPage = orderPaginationDto.page;
    const perPage = orderPaginationDto.limit;
    
    return {
      data: await this.prisma.order.findMany({
        skip: (currentPage! - 1) * perPage!,
        take: perPage,
        where: {
          status: orderPaginationDto.status
        }
      }),
      meta: {
        total: totalPages,
        page: currentPage,
        lastPage: Math.ceil(totalPages / perPage! )
      }
    }
  }

  async findOne(id: string) {
    const order = await this.prisma.order.findFirst({
      where: {id: id},
      include: {
          OrderItem: {
            select: {
              price: true,
              quantity: true,
              productoId: true,
            }
          }
        }
    })

    if (!order) {
      throw new RpcException({
        message: `Order with id #${id} not found`,
        status: HttpStatus.NOT_FOUND
      });
    }


    const productIds = order.OrderItem.map( orderItem => orderItem.productoId )
    const products: any[] = await firstValueFrom(
      this.client.send({cmd: 'validate_product'}, productIds)
    );

    return {
      ...order,
      OrderItem: order.OrderItem.map( orderItem => ({
        ...orderItem,
        name: products.find( product => product.id === orderItem.productoId).name,
      }))
    };

  }

  async changeStatus(changeOrderStatusDto: ChangeOrderStatusDto){
    const { id, status } = changeOrderStatusDto;

    const order = await this.findOne(id);

    if (order.status === status) return order;


    return this.prisma.order.update({
      where: { id },
      data: {status: status}
    });
  }

  async createPaymentSession(order: OrderWithProducts) {

    const paymentSession = await firstValueFrom(
      this.client.send('create.payment.session',{
        orderId: order.id,
        currency: 'usd',
        items: order.OrderItem.map( item => ({
          name: item.name,
          price: item.price,
          quantity: item.quantity
        }))
      })
    );

    return paymentSession;
  }

  async paidOrder (paidOrderDto: PaidOrderDto) {

    this.logger.log('Order Paid');
    this.logger.log(paidOrderDto);

    const order = await this.prisma.order.update({
      where: { id: paidOrderDto.orderId },
      data: {
        status: 'PAID',
        paid: true,
        paidAt: new Date(),
        stripeChargeId: paidOrderDto.stripePaymentId,

        // La relación

        orderReceipt: {
          create: {
            receiptUrl: paidOrderDto.receiptUrl
          }
        }
      }
    })

    return order;

  }

}
